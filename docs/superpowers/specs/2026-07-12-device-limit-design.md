# Admin-Configurable Device Limit — Design

**Date:** 2026-07-12

## Goal

Replace the current single-active-session lock with a per-user "how many devices
may be logged in simultaneously" limit that admins can edit. When a user exceeds
their limit on login, the oldest device is evicted. ADMIN users are unrestricted.

## Current behavior (baseline)

- `User.activeSessionId` (UUID string) holds the one allowed session.
- `login` mints a new UUID, stores it, signs it into the JWT as `sid`.
- `getMe` / `refreshToken` reject a token whose `sid` != `activeSessionId` with
  a 403 `SESSION_REPLACED` ("logged in on another device"). Frontend already
  handles this error.
- `refreshToken` deliberately reuses the existing `sid` (never mints a new one)
  to avoid two tabs refreshing simultaneously kicking each other out.

## New behavior

- Each user has an effective device limit:
  - `role === 'ADMIN'` → unlimited (check skipped entirely).
  - else → `user.deviceLimit ?? DEFAULT_DEVICE_LIMIT` (config default = 1, which
    preserves today's behavior for every existing user).
- `login` maintains a **list** of active sessions and evicts the oldest when the
  list would exceed the limit.
- Auth check passes if the token's `sid` is a member of the list.
- Admin can set/clear a user's `deviceLimit` in the existing Edit panel.
- Lowering a user's limit takes effect on their **next login** (no retroactive
  eviction).

## Storage — Option A (JSON array on the user row)

```prisma
model User {
  deviceLimit    Int?   @map("device_limit")            // null = use global default
  activeSessions Json?  @default("[]") @db.JsonB         // [{ sid: string, createdAt: ISO string }]
  activeSessionId String? @map("active_session_id") @db.Uuid  // KEPT this release; dropped later
  // ... existing fields unchanged
}
```

Chosen over a separate `Session` table because we only need a count + eviction,
not per-device visibility/revocation. No new table, no join on the hot auth path.
Mirrors the existing `preferences Json?` pattern.

## Config

`backend/src/config/index.js` gains:

```js
defaultDeviceLimit: parseInt(process.env.DEFAULT_DEVICE_LIMIT, 10) || 1,
```

## Session-list helper (new module `backend/src/utils/sessions.js`)

Pure functions, unit-testable in isolation:

- `normalizeSessions(raw)` → always returns an array of `{ sid, createdAt }`,
  dropping malformed entries. Tolerates `null`, non-array, missing fields.
- `addSession(list, sid, nowIso, limit)` → returns a NEW list with the new
  session appended, then trimmed to the newest `limit` entries by `createdAt`
  (oldest evicted). If `limit` is `Infinity`, no trimming.
- `hasSession(list, sid)` → boolean membership.

## Login flow (`authService.login`)

Wrapped in a transaction with a row lock to avoid the concurrent-login race:

1. `SELECT ... FOR UPDATE` the user row (via
   `prisma.$transaction` + `$queryRaw` lock, or `prisma.$transaction` with a
   read-then-write — see plan for exact mechanism).
2. Compute `limit`: `Infinity` if ADMIN else `deviceLimit ?? defaultDeviceLimit`.
3. `list = addSession(normalizeSessions(user.activeSessions), newSid, now, limit)`.
4. Persist `activeSessions = list`. (Also clear/ignore legacy `activeSessionId`.)
5. Sign token with `newSid`.

## Auth check (`authService.getMe` and `refreshToken`)

- If `user.role === 'ADMIN'` → skip the membership check (unrestricted).
- Else, if `payload.sid` is present and NOT in `normalizeSessions(user.activeSessions)`
  → throw `SESSION_REPLACED` (same status 403 / code / message as today).
- `refreshToken` NEVER mutates `activeSessions` — it only validates membership
  and re-signs, reusing the same `sid`. (Preserves the two-tab refresh fix.)

## Admin surface

- `updateBillingSchema` (validators/billing.js) gains:
  ```js
  deviceLimit: z.union([z.number().int().min(1), z.null()]).optional(),
  ```
  (integer ≥ 1, or null to reset to default; absent = unchanged.)
- `adminService.updateBilling` patches `deviceLimit` when `'deviceLimit' in data`.
- `BILLING_SELECT` and `listUsers` select include `deviceLimit` so the UI can
  show current value.
- Frontend `UserTable.js`: add a `deviceLimit` number input to the Edit draft
  (label from i18n `deviceLimitLabel`, both en/zh), included in `saveBilling`.

## Migration safety (mitigations)

1. **Additive + nullable.** `deviceLimit` null, `activeSessions` default `[]`.
2. **Backfill** existing sessions so nobody is logged out on deploy: for every
   user where `active_session_id IS NOT NULL`, set
   `active_sessions = [{ sid: active_session_id, createdAt: now }]`.
   Done in the same hand-written migration SQL.
3. `activeSessionId` column is **kept** this release (dropped in a future
   cleanup migration once all tokens have rotated).

## Side effects addressed

- **Concurrent logins race** → row-lock transaction in `login`.
- **Refresh eating slots** → refresh never mutates the array.
- **Deploy mass-logout** → backfill migration.
- **Admin exemption** → check skipped for ADMIN; their existing tokens keep working.
- **Lowering limit** → next-login effect (chosen); no retroactive eviction.
- **Stale/closed-tab sessions** → self-heal via oldest-eviction; no cleanup job.

## Testing

- Unit: `utils/sessions.js` (normalize, add/evict-oldest, membership, Infinity).
- Unit/integration: validator accepts int≥1 and null, rejects 0 / negative / float.
- Integration (against a test flow or scripted): login N+1 times with limit N →
  oldest sid rejected, newest N accepted; ADMIN unlimited; refresh doesn't evict.
- Migration: apply on a copy, verify backfill populated `active_sessions` and no
  existing token is invalidated.

## Out of scope (YAGNI)

- Per-device management UI (naming/listing/revoking individual devices).
- Dropping `activeSessionId` (separate later migration).
- IP-based restriction.
