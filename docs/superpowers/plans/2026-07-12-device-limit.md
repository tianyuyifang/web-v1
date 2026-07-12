# Device Limit Implementation Plan

**Goal:** Per-user admin-configurable simultaneous-device limit; oldest device evicted on over-limit login; admins unrestricted.

**Architecture:** JSON array `activeSessions` on the user row replaces the single `activeSessionId` semantics. Pure helper module handles list math. Login mutates the list under a row lock; auth check validates membership; refresh never mutates. Admin edits `deviceLimit` via the existing billing PATCH.

**Tech Stack:** Express, Prisma/PostgreSQL, Zod, Next.js/React frontend.

## Global Constraints

- Backend error format: `{ error: { message, status, details } }`.
- `SESSION_REPLACED` = status 403, code `'SESSION_REPLACED'`, message "Your account was logged in on another device" (unchanged).
- Default device limit = 1 (preserves current single-session behavior for all existing users).
- Migrations are hand-written dated SQL, applied with `npx prisma migrate deploy` (NOT `migrate dev`).
- i18n: keep en.js / zh.js key parity.
- ADMIN role = unrestricted (membership check skipped).

---

## Task 1: Session-list helper + unit tests

**Files:**
- Create: `backend/src/utils/sessions.js`
- Test: `backend/tests/sessions.test.js` (plain Node assert script runnable via `node`)

**Produces:** `normalizeSessions(raw) -> Array<{sid,createdAt}>`, `addSession(list, sid, nowIso, limit) -> Array`, `hasSession(list, sid) -> boolean`.

- [ ] Implement `sessions.js`:

```js
// Pure helpers for the per-user active-session list.
// A session entry is { sid: string, createdAt: string (ISO) }.

function normalizeSessions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e) => e && typeof e.sid === 'string' && typeof e.createdAt === 'string'
  ).map((e) => ({ sid: e.sid, createdAt: e.createdAt }));
}

// Append {sid, createdAt: nowIso}, then keep the newest `limit` by createdAt.
// limit === Infinity => no trimming.
function addSession(list, sid, nowIso, limit) {
  const next = normalizeSessions(list).concat({ sid, createdAt: nowIso });
  if (!Number.isFinite(limit)) return next;
  if (next.length <= limit) return next;
  // Sort ascending by createdAt, drop the oldest (length - limit) entries.
  const sorted = [...next].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return sorted.slice(sorted.length - limit);
}

function hasSession(list, sid) {
  return normalizeSessions(list).some((e) => e.sid === sid);
}

module.exports = { normalizeSessions, addSession, hasSession };
```

- [ ] Write `tests/sessions.test.js`:

```js
const assert = require('assert');
const { normalizeSessions, addSession, hasSession } = require('../src/utils/sessions');

// normalize tolerates junk
assert.deepStrictEqual(normalizeSessions(null), []);
assert.deepStrictEqual(normalizeSessions('x'), []);
assert.deepStrictEqual(normalizeSessions([{ sid: 'a', createdAt: '2020' }, { bad: 1 }]), [{ sid: 'a', createdAt: '2020' }]);

// add under limit keeps all
let l = addSession([], 's1', '2026-01-01T00:00:00.000Z', 2);
l = addSession(l, 's2', '2026-01-02T00:00:00.000Z', 2);
assert.strictEqual(l.length, 2);
assert.ok(hasSession(l, 's1') && hasSession(l, 's2'));

// add over limit evicts oldest
l = addSession(l, 's3', '2026-01-03T00:00:00.000Z', 2);
assert.strictEqual(l.length, 2);
assert.ok(!hasSession(l, 's1'), 'oldest s1 evicted');
assert.ok(hasSession(l, 's2') && hasSession(l, 's3'));

// limit 1 behaves like today
let one = addSession([], 'a', '2026-01-01T00:00:00.000Z', 1);
one = addSession(one, 'b', '2026-01-02T00:00:00.000Z', 1);
assert.deepStrictEqual(one.map((e) => e.sid), ['b']);

// Infinity never trims
let inf = [];
for (let i = 0; i < 5; i++) inf = addSession(inf, 's' + i, '2026-01-0' + (i + 1) + 'T00:00:00.000Z', Infinity);
assert.strictEqual(inf.length, 5);

console.log('sessions.test OK');
```

- [ ] Run: `cd backend && node tests/sessions.test.js` → prints `sessions.test OK`.
- [ ] Commit: `git add backend/src/utils/sessions.js backend/tests/sessions.test.js && git commit -m "feat: add session-list helper for device limit"`

---

## Task 2: Schema + migration (add fields, backfill)

**Files:**
- Modify: `backend/prisma/schema.prisma` (User model)
- Create: `backend/prisma/migrations/20260712000000_add_device_limit/migration.sql`

**Consumes:** nothing. **Produces:** `User.deviceLimit Int?`, `User.activeSessions Json?`.

- [ ] Add to User model (after `activeSessionId`):

```prisma
  deviceLimit     Int?       @map("device_limit")
  activeSessions  Json?      @default("[]") @map("active_sessions") @db.JsonB
```

- [ ] Write `migration.sql`:

```sql
ALTER TABLE "users" ADD COLUMN "device_limit" INTEGER;
ALTER TABLE "users" ADD COLUMN "active_sessions" JSONB DEFAULT '[]';

-- Backfill: preserve existing logins so nobody is logged out on deploy.
UPDATE "users"
SET "active_sessions" = jsonb_build_array(
  jsonb_build_object('sid', "active_session_id"::text, 'createdAt', now())
)
WHERE "active_session_id" IS NOT NULL;
```

- [ ] Regenerate client (backend must be stopped): `cd backend && npx prisma generate`
  Expected: "Generated Prisma Client". (If DLL lock error on Windows: `taskkill //F //IM node.exe` then retry.)
- [ ] Apply locally: `cd backend && npx prisma migrate deploy`
  Expected: migration `20260712000000_add_device_limit` applied.
- [ ] Verify backfill via a throwaway query (node): count users with non-empty `active_sessions` equals count with non-null `active_session_id`.
- [ ] Commit: `git add backend/prisma/schema.prisma backend/prisma/migrations/20260712000000_add_device_limit && git commit -m "feat: add device_limit and active_sessions columns with backfill"`

---

## Task 3: Config default

**Files:**
- Modify: `backend/src/config/index.js`

**Produces:** `config.defaultDeviceLimit` (number, default 1).

- [ ] Add to the exported object:

```js
  defaultDeviceLimit: parseInt(process.env.DEFAULT_DEVICE_LIMIT, 10) || 1,
```

- [ ] Commit: `git add backend/src/config/index.js && git commit -m "feat: add defaultDeviceLimit config"`

---

## Task 4: Auth service — login (list + row lock) and checks

**Files:**
- Modify: `backend/src/services/authService.js`

**Consumes:** `utils/sessions.js`, `config.defaultDeviceLimit`.

- [ ] Add imports at top:

```js
const { normalizeSessions, addSession, hasSession } = require('../utils/sessions');
```

- [ ] Add a helper for effective limit (module scope):

```js
function effectiveLimit(user) {
  if (user.role === 'ADMIN') return Infinity;
  return user.deviceLimit != null ? user.deviceLimit : config.defaultDeviceLimit;
}
```

- [ ] Replace the body of `login` (lines ~42-61) so it maintains the list under a row lock:

```js
async function login({ username, password }) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new UnauthorizedError('Invalid username or password');

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid username or password');

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Row-locked read-modify-write to avoid a concurrent-login race on the array.
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT active_sessions, role, device_limit FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
    const locked = rows[0];
    const limit = locked.role === 'ADMIN'
      ? Infinity
      : (locked.device_limit != null ? locked.device_limit : config.defaultDeviceLimit);
    const list = addSession(normalizeSessions(locked.active_sessions), sessionId, now, limit);
    return tx.user.update({
      where: { id: user.id },
      data: { activeSessions: list, activeSessionId: sessionId },
      select: { id: true, username: true, role: true, preferences: true },
    });
  });

  const token = signToken(updated, sessionId);
  return {
    token,
    user: { id: updated.id, username: updated.username, role: updated.role, preferences: updated.preferences },
  };
}
```

- [ ] In `getMe`: extend the user select to include `role`, `activeSessions`; replace the membership check. Find the block that selects `activeSessionId` and checks it, change to:

Select (getMe user fetch):
```js
    select: { id: true, username: true, role: true, activeSessionId: true, activeSessions: true },
```
Check:
```js
  // ADMIN unrestricted; others must have their sid in the active-sessions list.
  if (user.role !== 'ADMIN' && payload.sid && !hasSession(user.activeSessions, payload.sid)) {
    const err = new Error('Your account was logged in on another device');
    err.status = 403;
    err.code = 'SESSION_REPLACED';
    throw err;
  }
```

- [ ] In `refreshToken`: same select + same check as getMe (ADMIN skip, else membership). Do NOT mutate `activeSessions`. Keep the existing `sid` reuse logic for re-signing.

- [ ] Sanity run: `cd backend && node tests/sessions.test.js` (still green) and start backend to confirm no syntax error: `cd backend && node -e "require('./src/services/authService.js'); console.log('loads')"` → prints `loads`.
- [ ] Commit: `git add backend/src/services/authService.js && git commit -m "feat: device-limited login with row lock; membership auth check; admin exempt"`

---

## Task 5: Admin validator + service + select

**Files:**
- Modify: `backend/src/validators/billing.js`
- Modify: `backend/src/services/adminService.js`

- [ ] In `updateBillingSchema` add:

```js
  deviceLimit: z.union([z.number().int().min(1), z.null()]).optional(),
```

- [ ] In `adminService.js`, add `deviceLimit: true` to `BILLING_SELECT` and to the `listUsers` select object.
- [ ] In `updateBilling`, add:

```js
  if ('deviceLimit' in data) patch.deviceLimit = data.deviceLimit;
```

- [ ] Sanity: `cd backend && node -e "require('./src/validators/billing.js'); require('./src/services/adminService.js'); console.log('ok')"` → `ok`.
- [ ] Commit: `git add backend/src/validators/billing.js backend/src/services/adminService.js && git commit -m "feat: admin can set per-user deviceLimit"`

---

## Task 6: Frontend — deviceLimit in admin Edit panel

**Files:**
- Modify: `frontend/src/components/admin/UserTable.js`
- Modify: `frontend/src/i18n/en.js`, `frontend/src/i18n/zh.js`

- [ ] i18n: add `deviceLimitLabel` to both — en: `"Device limit"`, zh: `"设备数量上限"`. Add a helper hint key `deviceLimitHint` en: `"Blank = default (1). Admins unrestricted."`, zh: `"留空 = 默认（1）。管理员不受限。"`
- [ ] In `draftFor`, add `deviceLimit: user.deviceLimit != null ? String(user.deviceLimit) : ""`.
- [ ] In `saveBilling`, add to the updateBilling payload:
  `deviceLimit: d.deviceLimit === "" ? null : parseInt(d.deviceLimit, 10),`
- [ ] Add an input in the edit panel (next to fee), mirroring the fee input styling:

```jsx
<label className="flex flex-col text-xs text-muted">
  {t("deviceLimitLabel")}
  <input
    type="number"
    step="1"
    min="1"
    value={draftFor(user).deviceLimit}
    onChange={(e) => setDraft(user.id, { deviceLimit: e.target.value })}
    className="mt-0.5 w-24 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
    placeholder="1"
  />
</label>
```

- [ ] Build check: `cd frontend && npm run build` (or `npx next lint` on the file) → no errors.
- [ ] Commit: `git add frontend/src/components/admin/UserTable.js frontend/src/i18n/en.js frontend/src/i18n/zh.js && git commit -m "feat: admin UI to set per-user device limit"`

---

## Task 7: Verify end-to-end (runtime)

- [ ] Start backend + frontend locally.
- [ ] With `DEFAULT_DEVICE_LIMIT` unset (=1): log in same member account in two browsers → second login evicts first (first gets SESSION_REPLACED on next request). Confirms parity with old behavior.
- [ ] As admin, set that member's deviceLimit=2 → now two concurrent sessions both work; a third evicts the oldest.
- [ ] Log in as ADMIN in two browsers → both stay active (unrestricted).
- [ ] Refresh a member token repeatedly in one tab → does not evict the other allowed device.
- [ ] Capture observations.

---

## Task 8: Deploy

- [ ] Follow deployment memory: push to main, then on VM `git pull`, verify HEAD, `npx prisma migrate deploy` (BEFORE restart), build frontend, `pm2 restart` backend + frontend.
- [ ] Post-deploy: confirm existing users are NOT logged out (backfill worked), admin can set a limit, eviction works.
