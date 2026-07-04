# Account Billing / Subscription Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user monthly-subscription billing — expiration date, monthly fee (decimal), payment status, admin notes — with an admin management surface, a user-facing "Account" page + soft "expired" banner, and a navbar restructure (add Account, move Logout into Settings).

**Architecture:** Four nullable columns on the existing `users` table (plus a `PaymentStatus` enum) via a hand-written dated Prisma migration. Backend exposes admin billing endpoints (`PATCH .../billing`, `POST .../extend`) and folds the user's own billing summary (with a server-derived `status`) into the existing `GET /auth/me`. Frontend adds billing controls to the existing admin `UserTable`, a new `/account` page, an app-wide expired banner, and moves Logout from the navbar into Settings.

**Tech Stack:** Express.js + Prisma (PostgreSQL), Zod validation, Next.js 14 App Router, React 18, Zustand, Tailwind, i18n via `src/i18n/{en,zh}.js`.

## Global Constraints

- Backend error format is `{ error: { message, status, details } }`; frontend reads `err.response?.data?.error?.message`.
- Prisma `@map` snake_case columns; migrations are **hand-written dated SQL folders** under `backend/prisma/migrations/` (e.g. `20260704000000_add_user_billing/migration.sql`) — do NOT use `prisma migrate dev` auto-naming. After writing SQL, run `npx prisma migrate deploy` locally then `npx prisma generate`.
- Prisma generate fails if backend is running (Windows DLL lock) — stop backend first: `taskkill //F //IM node.exe`.
- New i18n keys MUST be added to BOTH `frontend/src/i18n/en.js` and `frontend/src/i18n/zh.js`.
- Monthly fee supports decimals; store as `Decimal(10,2)`.
- On expiry: **soft warning only** — never block access.
- `billingNotes` is admin-private — never returned by `GET /auth/me`.
- Admin routes under `/api/admin/*` already have `authMiddleware + requireRole('ADMIN')` applied in `server.js`; do not re-add.
- DATABASE_URL password contains `@` → URL-encoded `%40` (already configured in `.env`).

---

### Task 1: Database migration + Prisma schema (billing fields)

**Files:**
- Create: `backend/prisma/migrations/20260704000000_add_user_billing/migration.sql`
- Modify: `backend/prisma/schema.prisma:10-35` (add enum + 4 User fields)

**Interfaces:**
- Produces: `User.expiresAt: DateTime?`, `User.monthlyFee: Decimal?`, `User.paymentStatus: PaymentStatus?` (`PAID|UNPAID|OVERDUE`), `User.billingNotes: String?`. Columns: `expires_at`, `monthly_fee`, `payment_status`, `billing_notes`.

- [ ] **Step 1: Write the migration SQL**

Create `backend/prisma/migrations/20260704000000_add_user_billing/migration.sql`:

```sql
-- Per-user monthly subscription billing. All columns nullable (backwards compatible).
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'UNPAID', 'OVERDUE');

ALTER TABLE "users" ADD COLUMN "expires_at" TIMESTAMPTZ;
ALTER TABLE "users" ADD COLUMN "monthly_fee" DECIMAL(10,2);
ALTER TABLE "users" ADD COLUMN "payment_status" "PaymentStatus";
ALTER TABLE "users" ADD COLUMN "billing_notes" TEXT;
```

- [ ] **Step 2: Add the enum + fields to the Prisma schema**

In `backend/prisma/schema.prisma`, after the existing `Role` enum (line ~14) add:

```prisma
enum PaymentStatus {
  PAID
  UNPAID
  OVERDUE
}
```

Then inside `model User`, after the `activeSessionId` line, add:

```prisma
  expiresAt       DateTime?  @map("expires_at") @db.Timestamptz
  monthlyFee      Decimal?   @map("monthly_fee") @db.Decimal(10, 2)
  paymentStatus   PaymentStatus? @map("payment_status")
  billingNotes    String?    @map("billing_notes")
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Stop the backend if running, then run:

```bash
cd backend && taskkill //F //IM node.exe 2>/dev/null; npx prisma migrate deploy && npx prisma generate
```

Expected: "1 migration found" / "Applied ... 20260704000000_add_user_billing" and "Generated Prisma Client".

- [ ] **Step 4: Verify the columns exist**

Run:

```bash
cd backend && node -e "const p=require('./src/db/client');p.\$queryRawUnsafe(\"SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name IN ('expires_at','monthly_fee','payment_status','billing_notes') ORDER BY column_name\").then(r=>{console.log(r);process.exit(0)})"
```

Expected: four rows — `billing_notes`, `expires_at`, `monthly_fee`, `payment_status`.

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260704000000_add_user_billing/
git commit -m "feat(db): add user billing fields (expiry, fee, payment status, notes)"
```

---

### Task 2: Billing helper — derive subscription status

**Files:**
- Create: `backend/src/utils/billing.js`
- Test: `backend/tests/billing-test.js`

**Interfaces:**
- Produces:
  - `deriveStatus(expiresAt: Date|null, now?: Date): 'active'|'expired'` — `active` when `expiresAt` is null or strictly after `now`; `expired` when `expiresAt <= now`.
  - `addOneMonth(from: Date): Date` — returns a new Date one calendar month later, clamping day-of-month to the target month's last day (e.g. Jan 31 → Feb 28/29).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/billing-test.js`:

```javascript
const assert = require('assert');
const { deriveStatus, addOneMonth } = require('../src/utils/billing');

// deriveStatus
assert.strictEqual(deriveStatus(null), 'active', 'null expiry = active');
const past = new Date('2020-01-01T00:00:00Z');
const future = new Date('2999-01-01T00:00:00Z');
assert.strictEqual(deriveStatus(past), 'expired', 'past = expired');
assert.strictEqual(deriveStatus(future), 'active', 'future = active');

// addOneMonth — normal
const feb = addOneMonth(new Date('2026-01-15T00:00:00Z'));
assert.strictEqual(feb.toISOString().slice(0, 10), '2026-02-15', 'Jan 15 -> Feb 15');

// addOneMonth — end-of-month clamp (Jan 31 -> Feb 28 in 2026, non-leap)
const clamp = addOneMonth(new Date('2026-01-31T00:00:00Z'));
assert.strictEqual(clamp.toISOString().slice(0, 10), '2026-02-28', 'Jan 31 -> Feb 28');

// addOneMonth — leap year (Jan 31 2028 -> Feb 29)
const leap = addOneMonth(new Date('2028-01-31T00:00:00Z'));
assert.strictEqual(leap.toISOString().slice(0, 10), '2028-02-29', 'Jan 31 2028 -> Feb 29');

console.log('billing-test: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node tests/billing-test.js`
Expected: FAIL — `Cannot find module '../src/utils/billing'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/utils/billing.js`:

```javascript
/**
 * Derive subscription status from an expiration date.
 * @param {Date|string|null} expiresAt
 * @param {Date} [now]
 * @returns {'active'|'expired'}
 */
function deriveStatus(expiresAt, now = new Date()) {
  if (!expiresAt) return 'active';
  const exp = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return exp.getTime() > now.getTime() ? 'active' : 'expired';
}

/**
 * Add one calendar month to a date, clamping the day-of-month to the
 * target month's last day (Jan 31 -> Feb 28/29).
 * @param {Date} from
 * @returns {Date}
 */
function addOneMonth(from) {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);                       // avoid overflow while changing month
  d.setUTCMonth(d.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

module.exports = { deriveStatus, addOneMonth };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node tests/billing-test.js`
Expected: PASS — `billing-test: all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/billing.js backend/tests/billing-test.js
git commit -m "feat(billing): add status-derivation and add-one-month helpers"
```

---

### Task 3: Backend — expose billing in `getMe` (user self-service)

**Files:**
- Modify: `backend/src/services/authService.js:95-101` (`getMe`)
- Test: `backend/tests/me-billing-test.js`

**Interfaces:**
- Consumes: `deriveStatus` from `backend/src/utils/billing.js` (Task 2).
- Produces: `getMe(userId)` returns `{ id, username, role, preferences, expiresAt, monthlyFee, status }` where `status` is `'active'|'expired'`. `monthlyFee` is a number or null. Does NOT include `billingNotes` or `paymentStatus`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/me-billing-test.js`:

```javascript
const assert = require('assert');
const prisma = require('../src/db/client');
const { getMe } = require('../src/services/authService');

(async () => {
  // Create a temp user with an expired subscription and a fee
  const u = await prisma.user.create({
    data: {
      username: '__billing_test_' + Date.now(),
      passwordHash: 'x',
      role: 'MEMBER',
      expiresAt: new Date('2020-01-01T00:00:00Z'),
      monthlyFee: '29.90',
      paymentStatus: 'PAID',
      billingNotes: 'secret note',
    },
  });

  const me = await getMe(u.id);
  assert.strictEqual(me.status, 'expired', 'past expiry -> expired');
  assert.strictEqual(Number(me.monthlyFee), 29.9, 'fee returned as number');
  assert.ok(me.expiresAt, 'expiresAt present');
  assert.strictEqual(me.billingNotes, undefined, 'billingNotes must NOT be exposed');
  assert.strictEqual(me.paymentStatus, undefined, 'paymentStatus must NOT be exposed');

  await prisma.user.delete({ where: { id: u.id } });
  console.log('me-billing-test: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node tests/me-billing-test.js`
Expected: FAIL — `me.status` is `undefined` (assertion "past expiry -> expired" fails).

- [ ] **Step 3: Update `getMe`**

In `backend/src/services/authService.js`, add the require near the top (after line 6):

```javascript
const { deriveStatus } = require('../utils/billing');
```

Replace the `getMe` function (lines ~95-101) with:

```javascript
async function getMe(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, username: true, role: true, preferences: true,
      expiresAt: true, monthlyFee: true,
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    preferences: user.preferences,
    expiresAt: user.expiresAt,
    monthlyFee: user.monthlyFee == null ? null : Number(user.monthlyFee),
    status: deriveStatus(user.expiresAt),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node tests/me-billing-test.js`
Expected: PASS — `me-billing-test: all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/authService.js backend/tests/me-billing-test.js
git commit -m "feat(auth): expose own subscription status/fee via getMe (notes stay private)"
```

---

### Task 4: Backend — admin billing service methods

**Files:**
- Modify: `backend/src/services/adminService.js:8-13` (`listUsers` select) and module.exports (line ~168)
- Test: `backend/tests/admin-billing-test.js`

**Interfaces:**
- Consumes: `addOneMonth` from `backend/src/utils/billing.js` (Task 2); `NotFoundError` (already imported).
- Produces:
  - `listUsers()` — now selects `expiresAt, monthlyFee, paymentStatus, billingNotes` in addition to existing fields.
  - `updateBilling(id, { expiresAt, monthlyFee, paymentStatus, billingNotes })` — updates only provided keys; returns `{ id, username, role, expiresAt, monthlyFee, paymentStatus, billingNotes }`. Throws `NotFoundError` if user missing.
  - `extendOneMonth(id)` — sets `expiresAt` = `addOneMonth(base)` where base = `now` if current `expiresAt` is null or past, else current `expiresAt`; returns same shape as `updateBilling`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/admin-billing-test.js`:

```javascript
const assert = require('assert');
const prisma = require('../src/db/client');
const { updateBilling, extendOneMonth, listUsers } = require('../src/services/adminService');

(async () => {
  const u = await prisma.user.create({
    data: { username: '__admin_billing_' + Date.now(), passwordHash: 'x', role: 'MEMBER' },
  });

  // updateBilling sets fields
  const updated = await updateBilling(u.id, {
    monthlyFee: '30.00', paymentStatus: 'PAID', billingNotes: 'wechat',
    expiresAt: new Date('2026-08-01T00:00:00Z'),
  });
  assert.strictEqual(Number(updated.monthlyFee), 30, 'fee saved');
  assert.strictEqual(updated.paymentStatus, 'PAID', 'status saved');
  assert.strictEqual(updated.billingNotes, 'wechat', 'notes saved');

  // extendOneMonth from a future expiry -> +1 month from that expiry
  const ext = await extendOneMonth(u.id);
  assert.strictEqual(ext.expiresAt.toISOString().slice(0, 10), '2026-09-01', 'extend from future expiry');

  // extendOneMonth when expired -> ~1 month from today (just assert it is in the future)
  await updateBilling(u.id, { expiresAt: new Date('2020-01-01T00:00:00Z') });
  const ext2 = await extendOneMonth(u.id);
  assert.ok(ext2.expiresAt.getTime() > Date.now(), 'extend from past -> future date');

  // listUsers includes billing fields
  const all = await listUsers();
  const row = all.find((x) => x.id === u.id);
  assert.ok('paymentStatus' in row && 'expiresAt' in row, 'listUsers exposes billing fields');

  await prisma.user.delete({ where: { id: u.id } });
  console.log('admin-billing-test: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node tests/admin-billing-test.js`
Expected: FAIL — `updateBilling is not a function`.

- [ ] **Step 3: Implement the service methods**

In `backend/src/services/adminService.js`, add near the top (after line 2):

```javascript
const { addOneMonth } = require('../utils/billing');
```

Update `listUsers` (lines ~8-13) `select` to:

```javascript
async function listUsers() {
  return prisma.user.findMany({
    select: {
      id: true, username: true, role: true, createdAt: true,
      expiresAt: true, monthlyFee: true, paymentStatus: true, billingNotes: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}
```

Add these two functions before `module.exports`:

```javascript
const BILLING_SELECT = {
  id: true, username: true, role: true,
  expiresAt: true, monthlyFee: true, paymentStatus: true, billingNotes: true,
};

/**
 * Update any subset of a user's billing fields.
 * @param {string} id
 * @param {{ expiresAt?: Date|null, monthlyFee?: string|number|null, paymentStatus?: string|null, billingNotes?: string|null }} data
 */
async function updateBilling(id, data) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');

  const patch = {};
  if ('expiresAt' in data) patch.expiresAt = data.expiresAt;
  if ('monthlyFee' in data) patch.monthlyFee = data.monthlyFee;
  if ('paymentStatus' in data) patch.paymentStatus = data.paymentStatus;
  if ('billingNotes' in data) patch.billingNotes = data.billingNotes;

  return prisma.user.update({ where: { id }, data: patch, select: BILLING_SELECT });
}

/**
 * Extend a user's subscription by one calendar month.
 * Base = now if expiresAt is null or in the past, else current expiresAt.
 * @param {string} id
 */
async function extendOneMonth(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');

  const now = new Date();
  const base = user.expiresAt && user.expiresAt.getTime() > now.getTime() ? user.expiresAt : now;
  const expiresAt = addOneMonth(base);

  return prisma.user.update({ where: { id }, data: { expiresAt }, select: BILLING_SELECT });
}
```

Update the `module.exports` line to include the new methods:

```javascript
module.exports = { listUsers, listPending, approveUser, demoteUser, deleteUser, getBandwidthStats, listUserPlaylists, updateBilling, extendOneMonth };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node tests/admin-billing-test.js`
Expected: PASS — `admin-billing-test: all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/adminService.js backend/tests/admin-billing-test.js
git commit -m "feat(admin): billing service — updateBilling, extendOneMonth, list billing fields"
```

---

### Task 5: Backend — admin billing routes + Zod validator

**Files:**
- Create: `backend/src/validators/billing.js`
- Modify: `backend/src/routes/admin.js:1-2` (require validator) and add two routes before `module.exports`
- Test: `backend/tests/admin-billing-route-test.js`

**Interfaces:**
- Consumes: `updateBilling`, `extendOneMonth` from `adminService` (Task 4); `validate` middleware (`backend/src/middleware/validate.js`, same pattern as auth routes → puts parsed body on `req.validated`).
- Produces:
  - `PATCH /api/admin/users/:id/billing` — body `{ expiresAt?, monthlyFee?, paymentStatus?, billingNotes? }` → `{ user }`.
  - `POST /api/admin/users/:id/extend` → `{ user }`.
  - `updateBillingSchema` (Zod) exported from `backend/src/validators/billing.js`.

- [ ] **Step 1: Write the validator**

Create `backend/src/validators/billing.js`:

```javascript
const { z } = require('zod');

// All fields optional — admin PATCHes any subset. Nulls clear a field.
const updateBillingSchema = z.object({
  // Accept ISO date string or null; transform to Date (or null) for Prisma.
  expiresAt: z.string().datetime().nullable().optional()
    .transform((v) => (v == null ? v : new Date(v))),
  // Money: non-negative, up to 2 decimals. Kept as string for Prisma Decimal.
  monthlyFee: z.union([
    z.number().nonnegative(),
    z.string().regex(/^\d+(\.\d{1,2})?$/),
  ]).nullable().optional().transform((v) => (v == null ? v : String(v))),
  paymentStatus: z.enum(['PAID', 'UNPAID', 'OVERDUE']).nullable().optional(),
  billingNotes: z.string().max(1000).nullable().optional(),
});

module.exports = { updateBillingSchema };
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/admin-billing-route-test.js`:

```javascript
const assert = require('assert');
const { updateBillingSchema } = require('../src/validators/billing');

// Valid: partial patch with ISO date + string fee
const ok = updateBillingSchema.parse({ expiresAt: '2026-08-01T00:00:00.000Z', monthlyFee: '30.00', paymentStatus: 'PAID' });
assert.ok(ok.expiresAt instanceof Date, 'expiresAt transformed to Date');
assert.strictEqual(ok.monthlyFee, '30.00', 'fee kept as string');

// Valid: empty patch
assert.doesNotThrow(() => updateBillingSchema.parse({}), 'empty patch allowed');

// Valid: nulls clear fields
const cleared = updateBillingSchema.parse({ expiresAt: null, monthlyFee: null, billingNotes: null });
assert.strictEqual(cleared.expiresAt, null, 'null expiry allowed');

// Invalid: bad status
assert.throws(() => updateBillingSchema.parse({ paymentStatus: 'LATE' }), 'bad status rejected');
// Invalid: negative fee
assert.throws(() => updateBillingSchema.parse({ monthlyFee: -5 }), 'negative fee rejected');
// Invalid: 3-decimal fee string
assert.throws(() => updateBillingSchema.parse({ monthlyFee: '30.001' }), '3-decimal fee rejected');

console.log('admin-billing-route-test: all assertions passed');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && node tests/admin-billing-route-test.js`
Expected: FAIL — `Cannot find module '../src/validators/billing'` (until Step 1's file exists it fails; if Step 1 already created it, this test drives the route wiring in Step 4). Re-run after Step 1 to confirm the schema assertions pass, then proceed.

- [ ] **Step 4: Wire the routes**

In `backend/src/routes/admin.js`, update the top requires:

```javascript
const router = require('express').Router();
const adminService = require('../services/adminService');
const validate = require('../middleware/validate');
const { updateBillingSchema } = require('../validators/billing');
```

Add these two routes just before `module.exports = router;`:

```javascript
// PATCH /api/admin/users/:id/billing — update billing fields
router.patch('/users/:id/billing', validate(updateBillingSchema), async (req, res, next) => {
  try {
    const user = await adminService.updateBilling(req.params.id, req.validated);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/extend — extend subscription by one month
router.post('/users/:id/extend', async (req, res, next) => {
  try {
    const user = await adminService.extendOneMonth(req.params.id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Run the validator test to verify it passes**

Run: `cd backend && node tests/admin-billing-route-test.js`
Expected: PASS — `admin-billing-route-test: all assertions passed`.

- [ ] **Step 6: Smoke-test the routes end-to-end**

Start the backend (`cd backend && npm run dev` in another shell), then run this script that logs in as an admin, patches billing, and extends. Replace `ADMIN_USER`/`ADMIN_PASS` with the seeded admin creds from `.env`:

```bash
cd backend && node -e "
const http = require('http');
function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: 4000, path: '/api'+path, method, headers: { 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) , ...(data?{'Content-Length':Buffer.byteLength(data)}:{}) } }, (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b||'{}')})); });
    if (data) r.write(data); r.end();
  });
}
(async () => {
  const login = await req('POST','/auth/login',{username:process.env.ADMIN_1_USERNAME,password:process.env.ADMIN_1_PASSWORD});
  const token = login.body.token; console.log('login', login.status);
  const users = await req('GET','/admin/users',null,token);
  const target = users.body.users.find(u=>u.role!=='ADMIN'); console.log('target', target && target.username);
  const patch = await req('PATCH','/admin/users/'+target.id+'/billing',{monthlyFee:'30.00',paymentStatus:'PAID'},token);
  console.log('patch', patch.status, patch.body.user.monthlyFee, patch.body.user.paymentStatus);
  const ext = await req('POST','/admin/users/'+target.id+'/extend',null,token);
  console.log('extend', ext.status, ext.body.user.expiresAt);
  process.exit(0);
})();
"
```

Expected: `login 200`, a target username, `patch 200 30 PAID`, `extend 200 <a future ISO date>`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/validators/billing.js backend/src/routes/admin.js backend/tests/admin-billing-route-test.js
git commit -m "feat(admin): PATCH billing + POST extend routes with Zod validation"
```

---

### Task 6: Frontend — admin API client + i18n billing keys

**Files:**
- Modify: `frontend/src/lib/api.js:203-211` (`adminAPI`)
- Modify: `frontend/src/i18n/en.js`
- Modify: `frontend/src/i18n/zh.js`

**Interfaces:**
- Produces:
  - `adminAPI.updateBilling(id, data)` → `PATCH /admin/users/:id/billing`.
  - `adminAPI.extendOneMonth(id)` → `POST /admin/users/:id/extend`.
  - i18n keys (both locales): `navAccount`, `accountTitle`, `accountStatus`, `statusActive`, `statusExpired`, `expiresLabel`, `daysLeft`, `expiredAgo`, `monthlyFeeLabel`, `perMonth`, `renewalNotice`, `noExpiry`, `billingSectionTitle`, `feeColumn`, `expiresColumn`, `paymentStatusColumn`, `notesColumn`, `extendOneMonth`, `save`, `saved`, `payPaid`, `payUnpaid`, `payOverdue`, `logout`, `expiredBanner`.

- [ ] **Step 1: Add admin API methods**

In `frontend/src/lib/api.js`, extend the `adminAPI` object (after `getBandwidth`, line ~210):

```javascript
  updateBilling: (id, data) => api.patch(`/admin/users/${id}/billing`, data),
  extendOneMonth: (id) => api.post(`/admin/users/${id}/extend`),
```

- [ ] **Step 2: Add English i18n keys**

In `frontend/src/i18n/en.js`, add after `navSettings: "Settings",` (line 13):

```javascript
  navAccount: "Account",
```

And add near the end of the object (before the closing `};`):

```javascript
  // Account / billing
  accountTitle: "My Account",
  accountStatus: "Status",
  statusActive: "Active",
  statusExpired: "Expired",
  expiresLabel: "Expires",
  daysLeft: "{n} days left",
  expiredAgo: "expired {n} days ago",
  monthlyFeeLabel: "Monthly fee",
  perMonth: "/ month",
  renewalNotice: "Your subscription has expired. Please contact the admin to renew.",
  noExpiry: "No expiration set",
  billingSectionTitle: "Billing",
  feeColumn: "Fee",
  expiresColumn: "Expires",
  paymentStatusColumn: "Payment",
  notesColumn: "Notes",
  extendOneMonth: "+1 Month",
  save: "Save",
  saved: "Saved",
  payPaid: "Paid",
  payUnpaid: "Unpaid",
  payOverdue: "Overdue",
  logout: "Log out",
  expiredBanner: "Your subscription has expired. Please renew.",
```

- [ ] **Step 3: Add Chinese i18n keys**

In `frontend/src/i18n/zh.js`, add after `navSettings: "设置",` (line 13):

```javascript
  navAccount: "账户",
```

And add near the end of the object (before the closing `};`):

```javascript
  // 账户 / 计费
  accountTitle: "我的账户",
  accountStatus: "状态",
  statusActive: "有效",
  statusExpired: "已过期",
  expiresLabel: "到期时间",
  daysLeft: "剩余 {n} 天",
  expiredAgo: "已过期 {n} 天",
  monthlyFeeLabel: "月费",
  perMonth: "/ 月",
  renewalNotice: "您的订阅已过期，请联系管理员续费。",
  noExpiry: "未设置到期时间",
  billingSectionTitle: "计费",
  feeColumn: "费用",
  expiresColumn: "到期",
  paymentStatusColumn: "付款",
  notesColumn: "备注",
  extendOneMonth: "+1 个月",
  save: "保存",
  saved: "已保存",
  payPaid: "已付",
  payUnpaid: "未付",
  payOverdue: "逾期",
  logout: "退出登录",
  expiredBanner: "您的订阅已过期，请续费。",
```

- [ ] **Step 4: Verify both locales parse and have matching keys**

Run:

```bash
cd frontend && node -e "const en=require('./src/i18n/en.js').default||require('./src/i18n/en.js');const zh=require('./src/i18n/zh.js').default||require('./src/i18n/zh.js');const ek=Object.keys(en),zk=Object.keys(zh);const miss=ek.filter(k=>!(k in zh)).concat(zk.filter(k=>!(k in en)));console.log('en keys',ek.length,'zh keys',zk.length,'mismatch',miss)" 2>/dev/null || echo "NOTE: if ESM import fails, instead just confirm 'npm run build' passes in a later task"
```

Expected: `mismatch []` (or the fallback note — the real check is the build in Task 10).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.js frontend/src/i18n/en.js frontend/src/i18n/zh.js
git commit -m "feat(frontend): admin billing API methods + account/billing i18n keys"
```

---

### Task 7: Frontend — billing controls in admin UserTable

**Files:**
- Modify: `frontend/src/components/admin/UserTable.js`

**Interfaces:**
- Consumes: `adminAPI.updateBilling`, `adminAPI.extendOneMonth` (Task 6); i18n keys (Task 6); `user.expiresAt`, `user.monthlyFee`, `user.paymentStatus`, `user.billingNotes` from `listUsers` (Task 4).
- Produces: per-row billing editor (expires date input, +1 Month button, fee input, payment-status select, notes input, Save). Calls `onRefresh` after save/extend (existing prop).

- [ ] **Step 1: Add a billing editor row under each user**

In `frontend/src/components/admin/UserTable.js`, add local state for the billing draft at the top of the component (after the existing `deleteTarget` state, line ~15):

```javascript
  const [billingDraft, setBillingDraft] = useState({});

  function draftFor(user) {
    const d = billingDraft[user.id];
    if (d) return d;
    return {
      expiresAt: user.expiresAt ? String(user.expiresAt).slice(0, 10) : "",
      monthlyFee: user.monthlyFee != null ? String(user.monthlyFee) : "",
      paymentStatus: user.paymentStatus || "",
      billingNotes: user.billingNotes || "",
    };
  }

  function setDraft(userId, patch) {
    setBillingDraft((prev) => ({ ...prev, [userId]: { ...draftFor({ id: userId, ...users.find((u) => u.id === userId) }), ...patch } }));
  }

  async function saveBilling(user) {
    const d = draftFor(user);
    await perform(user.id, () => adminAPI.updateBilling(user.id, {
      expiresAt: d.expiresAt ? new Date(d.expiresAt + "T00:00:00.000Z").toISOString() : null,
      monthlyFee: d.monthlyFee === "" ? null : d.monthlyFee,
      paymentStatus: d.paymentStatus || null,
      billingNotes: d.billingNotes || null,
    }));
    setBillingDraft((prev) => { const n = { ...prev }; delete n[user.id]; return n; });
  }

  async function extend(user) {
    await perform(user.id, () => adminAPI.extendOneMonth(user.id));
    setBillingDraft((prev) => { const n = { ...prev }; delete n[user.id]; return n; });
  }
```

- [ ] **Step 2: Render the billing editor as a second row per user**

In the `<tbody>` map, change each iteration to render the existing row plus a billing row. Replace the `{users.map((user) => (` block's returned `<tr>...</tr>` with a React fragment containing both rows. Insert this new row immediately after the existing `</tr>` that closes the actions row (line ~108), still inside the `.map`:

```javascript
              <tr key={user.id + "-billing"} className="border-b border-border/50 last:border-0">
                <td colSpan={4} className="pb-3">
                  <div className="flex flex-wrap items-end gap-2 rounded-lg bg-background/60 px-3 py-2">
                    <label className="flex flex-col text-xs text-muted">
                      {t("expiresColumn")}
                      <input
                        type="date"
                        value={draftFor(user).expiresAt}
                        onChange={(e) => setDraft(user.id, { expiresAt: e.target.value })}
                        className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      />
                    </label>
                    <button
                      onClick={() => extend(user)}
                      disabled={loading[user.id]}
                      className="rounded-md border border-primary/40 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                    >
                      {t("extendOneMonth")}
                    </button>
                    <label className="flex flex-col text-xs text-muted">
                      {t("feeColumn")}
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={draftFor(user).monthlyFee}
                        onChange={(e) => setDraft(user.id, { monthlyFee: e.target.value })}
                        className="mt-0.5 w-24 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      />
                    </label>
                    <label className="flex flex-col text-xs text-muted">
                      {t("paymentStatusColumn")}
                      <select
                        value={draftFor(user).paymentStatus}
                        onChange={(e) => setDraft(user.id, { paymentStatus: e.target.value })}
                        className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      >
                        <option value="">—</option>
                        <option value="PAID">{t("payPaid")}</option>
                        <option value="UNPAID">{t("payUnpaid")}</option>
                        <option value="OVERDUE">{t("payOverdue")}</option>
                      </select>
                    </label>
                    <label className="flex flex-1 flex-col text-xs text-muted">
                      {t("notesColumn")}
                      <input
                        type="text"
                        value={draftFor(user).billingNotes}
                        onChange={(e) => setDraft(user.id, { billingNotes: e.target.value })}
                        className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      />
                    </label>
                    <button
                      onClick={() => saveBilling(user)}
                      disabled={loading[user.id]}
                      className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
                    >
                      {t("save")}
                    </button>
                  </div>
                </td>
              </tr>
```

To make the two `<tr>`s share one `.map` iteration, wrap them in a `<React.Fragment key={user.id}>`: change `{users.map((user) => (` to `{users.map((user) => (` returning a fragment. Concretely, replace the opening `<tr key={user.id} ...>` with `<React.Fragment key={user.id}><tr ...>` (remove the `key` from that inner `<tr>`) and add `</React.Fragment>` after the new billing `<tr>`. Add `import React from "react";` at the top if not present (Next.js 14 auto-imports JSX runtime, but `React.Fragment` needs the import — alternatively use `<Fragment>` and `import { Fragment, useState } from "react";`).

Use the `Fragment` approach for clarity — update the import line at top:

```javascript
import { useState, Fragment } from "react";
```

and use `<Fragment key={user.id}>` / `</Fragment>`.

- [ ] **Step 3: Manually verify in the browser**

Start frontend + backend, log in as admin, visit `/admin`. Confirm each user row now has a billing editor: set a fee + status + expiry, click Save → row refreshes and values persist on reload. Click +1 Month → expiry advances.

Expected: values persist after refresh; no console errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/admin/UserTable.js
git commit -m "feat(admin-ui): per-user billing editor (expiry, +1 month, fee, status, notes)"
```

---

### Task 8: Frontend — `/account` page + navbar Account link

**Files:**
- Create: `frontend/src/app/account/page.js`
- Modify: `frontend/src/components/layout/Navbar.js:72-85` (desktop nav) and `:105-117` (mobile nav)

**Interfaces:**
- Consumes: `useAuth()` → `user` with `expiresAt`, `monthlyFee`, `status` (Task 3); i18n keys (Task 6).
- Produces: `/account` route; navbar `Account` link before Settings in both desktop and mobile menus.

- [ ] **Step 1: Create the account page**

Create `frontend/src/app/account/page.js`:

```javascript
"use client";

import { useMemo } from "react";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function AccountPage() {
  const { user, loading } = useAuth();
  const { t } = useLanguage();

  const daysInfo = useMemo(() => {
    if (!user?.expiresAt) return null;
    const ms = new Date(user.expiresAt).getTime() - Date.now();
    const days = Math.round(Math.abs(ms) / (24 * 60 * 60 * 1000));
    return ms >= 0
      ? t("daysLeft").replace("{n}", days)
      : t("expiredAgo").replace("{n}", days);
  }, [user, t]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!user) return null;

  const expired = user.status === "expired";

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-theme">{t("accountTitle")}</h1>
      </div>

      <div className="rounded-xl border border-border bg-surface p-6 space-y-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">{t("accountStatus")}</span>
          <span
            className={`rounded-full px-3 py-0.5 text-xs font-semibold ${
              expired ? "bg-red-500/15 text-red-400" : "bg-green-500/15 text-green-400"
            }`}
          >
            {expired ? t("statusExpired") : t("statusActive")}
          </span>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4">
          <span className="text-sm text-muted">{t("expiresLabel")}</span>
          <span className="text-sm text-theme">
            {user.expiresAt
              ? `${new Date(user.expiresAt).toLocaleDateString()}${daysInfo ? ` · ${daysInfo}` : ""}`
              : t("noExpiry")}
          </span>
        </div>

        {user.monthlyFee != null && (
          <div className="flex items-center justify-between border-t border-border pt-4">
            <span className="text-sm text-muted">{t("monthlyFeeLabel")}</span>
            <span className="text-sm text-theme">
              ¥{Number(user.monthlyFee).toFixed(2)} {t("perMonth")}
            </span>
          </div>
        )}

        {expired && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {t("renewalNotice")}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the Account link to the desktop navbar**

In `frontend/src/components/layout/Navbar.js`, in the desktop nav block, add the Account link immediately before the Settings link (line ~78):

```javascript
              {navLink("/account", t("navAccount"))}
              {navLink("/settings", t("navSettings"))}
```

- [ ] **Step 3: Add the Account link to the mobile navbar**

In the mobile dropdown block, add before the Settings link (line ~110):

```javascript
            {navLink("/account", t("navAccount"))}
            {navLink("/settings", t("navSettings"))}
```

- [ ] **Step 4: Manually verify**

Log in as any user, click the new `Account` navbar link → `/account` shows status/expiry/fee. For an expired test user, the renewal notice appears. Confirm the fee row is hidden when `monthlyFee` is null.

Expected: page renders correctly for active, expired, and no-billing users.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/account/page.js frontend/src/components/layout/Navbar.js
git commit -m "feat(account): user Account page + navbar Account link"
```

---

### Task 9: Frontend — move Logout into Settings + app-wide expired banner

**Files:**
- Modify: `frontend/src/components/layout/Navbar.js` (remove desktop + mobile Logout buttons; remove now-unused logout/router wiring if not otherwise used)
- Modify: `frontend/src/app/settings/page.js` (add Logout section)
- Create: `frontend/src/components/layout/ExpiredBanner.js`
- Modify: `frontend/src/app/layout.js` (mount `ExpiredBanner`)

**Interfaces:**
- Consumes: `useAuth()` → `logout`, `user.status` (Tasks 3, 8); i18n keys `logout`, `expiredBanner` (Task 6).
- Produces: Logout button in Settings; `ExpiredBanner` shown app-wide when `user.status === 'expired'`.

- [ ] **Step 1: Remove Logout from the desktop navbar**

In `frontend/src/components/layout/Navbar.js`, delete the desktop Logout `<button>` (lines ~79-84):

```javascript
              <button
                onClick={handleLogout}
                className="ml-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                {t("navLogout")}
              </button>
```

- [ ] **Step 2: Remove Logout from the mobile navbar**

Delete the mobile Logout `<button>` (lines ~111-116):

```javascript
            <button
              onClick={handleLogout}
              className="rounded-md px-3 py-1.5 text-left text-sm font-medium text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              {t("navLogout")}
            </button>
```

Then remove the now-unused `handleLogout` function and, if `router`/`logout` are no longer referenced anywhere else in the file, remove them from the `useAuth()` destructure and drop the `useRouter` import. (Verify by searching the file for `router` and `logout` before deleting.)

- [ ] **Step 3: Add a Logout section to Settings**

In `frontend/src/app/settings/page.js`, add to the imports at top:

```javascript
import useAuth from "@/hooks/useAuth";
import { useRouter } from "next/navigation";
```

Inside `SettingsPage`, add near the other hooks (after `const { lang, setLang, t } = useLanguage();`):

```javascript
  const { logout } = useAuth();
  const router = useRouter();

  function handleLogout() {
    logout();
    router.push("/login");
  }
```

Add this as the last card inside the `<div className="space-y-6">` container (after the Change Password card, before its closing `</div>`):

```javascript
        {/* Logout */}
        <div className="rounded-xl border border-border bg-surface p-6">
          <button
            onClick={handleLogout}
            className="w-full rounded-lg border border-red-500/30 px-4 py-2.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
          >
            {t("logout")}
          </button>
        </div>
```

- [ ] **Step 4: Create the ExpiredBanner component**

Create `frontend/src/components/layout/ExpiredBanner.js`:

```javascript
"use client";

import { useState } from "react";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ExpiredBanner() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || user?.status !== "expired") return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-red-500/15 px-4 py-2 text-sm text-red-400">
      <span>{t("expiredBanner")}</span>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded px-2 py-0.5 text-xs hover:bg-red-500/20"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Mount the banner app-wide**

In `frontend/src/app/layout.js`, the shell is `<Navbar />` followed by `<main ...>{children}</main>` (Navbar imported at top, rendered ~line 17). Add the import alongside the Navbar import:

```javascript
import ExpiredBanner from "@/components/layout/ExpiredBanner";
```

and insert `<ExpiredBanner />` between `<Navbar />` and `<main ...>`:

```javascript
            <Navbar />
            <ExpiredBanner />
            <main className="mx-auto max-w-screen-2xl px-4 pb-6">{children}</main>
```

- [ ] **Step 6: Manually verify**

- Navbar no longer shows Logout (desktop + mobile). Settings page has a Log out button that logs out → `/login`.
- Log in as an expired test user → red banner appears at the top of every page; ✕ dismisses it for the session.
- Active user → no banner.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/layout/Navbar.js frontend/src/app/settings/page.js frontend/src/components/layout/ExpiredBanner.js frontend/src/app/layout.js
git commit -m "feat(account): move Logout into Settings; add app-wide expired banner"
```

---

### Task 10: Full build + end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Backend tests all pass**

Run each billing test:

```bash
cd backend && node tests/billing-test.js && node tests/me-billing-test.js && node tests/admin-billing-test.js && node tests/admin-billing-route-test.js
```

Expected: all four print "all assertions passed".

- [ ] **Step 2: Frontend production build passes**

Run:

```bash
cd frontend && npm run build
```

Expected: build completes with no errors (i18n keys resolve, `/account` route compiles).

- [ ] **Step 3: Manual end-to-end walkthrough**

With backend + frontend running:
1. Admin sets a user's fee=30, status=Paid, expiry to a future date → Save; reload `/admin` → persists.
2. Admin clicks +1 Month → expiry advances one month.
3. That user logs in → `/account` shows Active, correct date + "N days left", ¥30.00 / month. No banner.
4. Admin sets that user's expiry to a past date → user (after re-`me()`/reload) sees Expired status, renewal notice on `/account`, and the app-wide red banner. Access is NOT blocked (playlists/library still work).
5. Logout lives only in Settings and works.

Expected: all steps behave as described.

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test: verify account billing end-to-end"
```

---

## Deployment note

After merge, deploy per the standard workflow (push to `main`, then on the VM `git pull` + rebuild frontend + `pm2 restart`). The migration must run on the VM: `cd ~/web-v1/backend && npx prisma migrate deploy`. This is a follow-up action, not part of these tasks.
