# Active Session Cache Implementation Plan

**Goal:** Cache `activeSessionId` lookups in `requireActiveSession` middleware so audio-streaming traffic stops saturating the Prisma connection pool.

**Architecture:** Module-level `Map<userId, { activeSessionId, expiresAt }>` inside `backend/src/middleware/auth.js`. 30-second TTL. On request, consult the cache first; on hit-and-valid, skip the DB; on miss/expiry, do the existing `findUnique` and write the result back.

**Spec:** [`docs/superpowers/specs/2026-05-11-active-session-cache-design.md`](../specs/2026-05-11-active-session-cache-design.md)

---

## Task 1: Add session cache to `requireActiveSession`

**Files:**
- Modify: `backend/src/middleware/auth.js`

- [ ] **Step 1: Read the current `requireActiveSession`**

The current implementation (lines 30–59):

```js
async function requireActiveSession(req, res, next) {
  if (!req.user?.sid) {
    // Token has no sessionId (issued before session restriction) — allow through
    return next();
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { activeSessionId: true },
    });
    if (!user) {
      return next(new UnauthorizedError('User not found'));
    }
    // If activeSessionId is null, user hasn't logged in since migration — skip check
    if (!user.activeSessionId) {
      return next();
    }
    if (user.activeSessionId !== req.user.sid) {
      return res.status(403).json({
        error: {
          code: 'SESSION_REPLACED',
          message: 'Your account was logged in on another device',
        },
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 2: Add module-scoped cache state**

Near the top of `backend/src/middleware/auth.js`, after the imports (before `function authMiddleware`), insert:

```js
// In-process cache for activeSessionId lookups. Avoids hammering Prisma's
// connection pool on high-frequency authenticated routes (audio streaming).
// Tradeoff: kicked sessions get up to SESSION_CACHE_TTL_MS of grace before
// the next DB read picks up the new activeSessionId. Acceptable; this is a
// performance optimization, not a security boundary.
const SESSION_CACHE = new Map();
const SESSION_CACHE_TTL_MS = 30 * 1000;
```

- [ ] **Step 3: Replace `requireActiveSession` with the cached version**

Replace the function body so a cache hit short-circuits the DB lookup. The kick comparison logic stays identical.

```js
async function requireActiveSession(req, res, next) {
  if (!req.user?.sid) {
    // Token has no sessionId (issued before session restriction) — allow through
    return next();
  }
  try {
    const userId = req.user.id;
    const now = Date.now();
    let activeSessionId;

    const cached = SESSION_CACHE.get(userId);
    if (cached && cached.expiresAt > now) {
      activeSessionId = cached.activeSessionId;
    } else {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { activeSessionId: true },
      });
      if (!user) {
        return next(new UnauthorizedError('User not found'));
      }
      activeSessionId = user.activeSessionId;
      SESSION_CACHE.set(userId, {
        activeSessionId,
        expiresAt: now + SESSION_CACHE_TTL_MS,
      });
    }

    // If activeSessionId is null, user hasn't logged in since migration — skip check
    if (!activeSessionId) {
      return next();
    }
    if (activeSessionId !== req.user.sid) {
      return res.status(403).json({
        error: {
          code: 'SESSION_REPLACED',
          message: 'Your account was logged in on another device',
        },
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 4: Commit**

```
git add backend/src/middleware/auth.js
git commit -m "Cache activeSessionId in requireActiveSession middleware"
```

---

## Self-review

- Spec called for a module-scoped `Map` with 30s TTL → Step 2 adds exactly that.
- Spec called for "consult cache, on hit-and-valid skip DB, on miss/expiry do existing findUnique and write back" → Step 3 does exactly that.
- The kick-comparison logic (`activeSessionId !== req.user.sid`) is preserved verbatim.
- The pre-migration null short-circuits (no `sid` claim, no stored `activeSessionId`) are preserved verbatim.
- No new dependencies, no config changes, no other files modified.
