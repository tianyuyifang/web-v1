# Active session cache — design

## Problem

`requireActiveSession` middleware runs `prisma.user.findUnique` on every authenticated request to verify the JWT's session id matches the user's stored `activeSessionId`. Audio streaming (`/api/stream/*`) generates many requests per second per tab as the browser fetches byte ranges. With 5+ tabs open, the DB connection pool (default `numCpus * 2 + 1` — only 5 on a 2-vCPU VM) is saturated; subsequent requests queue, manifesting as a stuck UI, audio glitches, and slow page loads. Closing tabs drains the queue, restoring responsiveness — the classic symptom of pool exhaustion.

## Goal

Eliminate the per-request DB hit in `requireActiveSession` by caching the user's `activeSessionId` in process memory for a short TTL. The cache is consulted first; on miss or expiry the DB is queried and the cache updated.

## Non-goals

- Strict instant-kick semantics (currently every request hits the DB; the new behavior tolerates up to TTL seconds of stale data).
- Cluster/multi-process consistency (the backend runs PM2 in fork mode — single process).
- Cross-route deduplication of in-flight DB lookups for the same user (a single user firing 50 concurrent requests on a cold cache will spawn 50 lookups; acceptable since this is rare and the cache fills on first response).

## Approach

A simple module-level `Map<userId, { activeSessionId, expiresAt }>` lives inside the auth middleware module.

- **TTL: 30 seconds.** Short enough that a kicked session loses its grace period quickly; long enough to absorb burst load (a typical page load + first second of audio playback generates well under a 30-second window of requests, all served from cache after the first).
- **Cache key:** `userId` (string). One entry per active user.
- **Cache value:** `{ activeSessionId: string|null, expiresAt: number }`. `null` is a valid cached value — it means "this user has no enforced active session" (pre-migration login).
- **Bound:** No explicit eviction beyond TTL. The map only grows with distinct active users; entries naturally expire. We add a tiny lazy-cleanup pass on every read to drop expired entries, which keeps the map size bounded by the number of users active in any 30-second window.

## Behavior

On request:

1. Look up `userId` in cache. If hit and not expired, use the cached `activeSessionId` directly. Skip DB.
2. If miss or expired, run the same `prisma.user.findUnique` as today, store the result with `expiresAt = now + TTL_MS`, then apply the same comparison logic.

The downstream comparison (`if (user.activeSessionId !== req.user.sid)`) is unchanged. The `null`/`undefined` short-circuits in the existing code (no `sid` claim → allow; no `activeSessionId` stored → allow) are preserved.

## Side effects

- **Up to 30-second grace period after being kicked.** A device kicked when another device logs in will continue working for up to TTL seconds. After that, the next request triggers a fresh DB read, sees the new `activeSessionId`, and rejects with `SESSION_REPLACED`.
- **Memory cost is negligible.** Each entry is ~50 bytes; in the worst case where every user logs in within a TTL window, the map size equals the active user count.
- **No correctness issue under PM2 fork mode** (single process; one cache). If we ever switch to cluster mode, each worker has its own cache, bounding inconsistency to TTL — still fine.

## File changes

Modify `backend/src/middleware/auth.js`:
- Add a module-scoped `const SESSION_CACHE = new Map();`
- Add a module-scoped `const TTL_MS = 30 * 1000;`
- Inside `requireActiveSession`, before the `prisma.user.findUnique`, check the cache. On hit, use the cached value and skip the DB. On miss or expiry, do the DB lookup and write to the cache.
- Add a small `cleanupExpired` helper that runs on every read (cheap — just iterates the map). Alternatively skip cleanup since entries are checked on access; size growth is bounded by active-user count.

No other files modified. No new dependencies. No config changes (TTL is hard-coded; can be tuned later if needed).

## Out of scope

- A more sophisticated cache (LRU, Redis-backed) — module-level Map is sufficient for this workload.
- Eager cache invalidation on login (calling `SESSION_CACHE.delete(userId)` from the login handler) — would shorten the grace window to zero but adds coupling to the auth service. TTL-based expiry is simpler and sufficient.
- Cluster mode migration. The cache is per-process; if cluster mode is adopted, each worker has its own cache, and a kicked session may experience up to TTL × (worker count / 1) extra grace per worker until it cycles through them. Acceptable.

## Manual test plan

1. **Functional regression — kick still works.** Log in as user X on device 1. Play audio. Log in as user X on device 2. Within ~30 seconds after the second login, device 1 should be redirected to login on its next action. (Was instant before; now up to 30s.)
2. **No stuck with many tabs.** Open 6 tabs on the same account, start audio on a few. Observe that the UI remains responsive, audio plays without glitching, and no request stalls.
3. **Cache hit observable in logs (optional).** Add a temporary `console.log` to the middleware showing "HIT" vs "MISS" — confirm that after the first request, subsequent requests log "HIT" for the same user, and a fresh "MISS" appears after 30s of inactivity. Remove the log after verification.
4. **Pre-migration users.** Existing logins with no `sid` claim or no stored `activeSessionId` continue to pass through (cached as `null`).
5. **Login on another device updates the cache eventually.** As (1), but specifically verify the device-1 user becomes blocked within 30 seconds of the device-2 login.
