const jwt = require('jsonwebtoken');
const config = require('../config');
const prisma = require('../db/client');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const { hasSession } = require('../utils/sessions');

// In-process cache for active-session lookups. Avoids hammering Prisma's
// connection pool on high-frequency authenticated routes (audio streaming).
// Tradeoff: kicked sessions get up to SESSION_CACHE_TTL_MS of grace before
// the next DB read picks up the new active-sessions list. Acceptable; this is a
// performance optimization, not a security boundary.
const SESSION_CACHE = new Map();
const SESSION_CACHE_TTL_MS = 30 * 1000;

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  // Also accept token as query param (needed for audio streaming via <audio> element)
  const token = (header && header.startsWith('Bearer ') ? header.slice(7) : null)
    || req.query.token;

  if (!token) {
    return next(new UnauthorizedError('Missing or invalid authorization header'));
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, username: payload.username, role: payload.role, sid: payload.sid };
    next();
  } catch (err) {
    next(new UnauthorizedError('Invalid or expired token'));
  }
}

/**
 * Middleware: verify the JWT's sessionId is one of the user's active sessions.
 * Returns 403 SESSION_REPLACED if the session was evicted (device limit exceeded
 * by a newer login). ADMIN users are unrestricted. Skips the check if the token
 * has no sessionId (pre-migration login) or the user has no recorded sessions.
 * Should be used after authMiddleware.
 */
async function requireActiveSession(req, res, next) {
  if (!req.user?.sid) {
    // Token has no sessionId (issued before session restriction) — allow through
    return next();
  }
  try {
    const userId = req.user.id;
    const now = Date.now();
    let role;
    let activeSessions;

    const cached = SESSION_CACHE.get(userId);
    if (cached && cached.expiresAt > now) {
      role = cached.role;
      activeSessions = cached.activeSessions;
    } else {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, activeSessions: true },
      });
      if (!user) {
        return next(new UnauthorizedError('User not found'));
      }
      role = user.role;
      activeSessions = user.activeSessions;
      SESSION_CACHE.set(userId, {
        role,
        activeSessions,
        expiresAt: now + SESSION_CACHE_TTL_MS,
      });
    }

    // ADMIN is unrestricted — any number of simultaneous devices allowed.
    if (role === 'ADMIN') {
      return next();
    }
    // No recorded sessions (hasn't logged in since migration) — skip check.
    let list = Array.isArray(activeSessions) ? activeSessions : [];
    if (list.length === 0) {
      return next();
    }
    if (!hasSession(list, req.user.sid)) {
      // Never evict off the cache alone. A fresh login writes its session to
      // the database, but a list cached seconds earlier doesn't have it, and
      // kicking on that stale copy sent people who had just signed in
      // straight back to the login page — deterministically, for up to 30
      // seconds (261 times in the last two weeks of logs). A wrongful ALLOW
      // for one TTL is the accepted tradeoff of this cache; a wrongful KICK
      // was never meant to be. So the verdict that logs someone out must
      // always come from the database, read now.
      const fresh = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, activeSessions: true },
      });
      if (!fresh) {
        return next(new UnauthorizedError('User not found'));
      }
      list = Array.isArray(fresh.activeSessions) ? fresh.activeSessions : [];
      SESSION_CACHE.set(userId, {
        role: fresh.role,
        activeSessions: list,
        expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
      });
      if (fresh.role !== 'ADMIN' && list.length > 0 && !hasSession(list, req.user.sid)) {
        return res.status(403).json({
          error: {
            code: 'SESSION_REPLACED',
            message: 'Your account was logged in on another device',
          },
        });
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware factory: requires the authenticated user to have one of the given roles.
 * Must be used after authMiddleware.
 *
 * @param {...string} roles - Allowed roles (e.g. 'ADMIN', 'MEMBER')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ForbiddenError('Insufficient permissions'));
    }
    next();
  };
}

/**
 * Middleware: rejects PENDING users with a 403.
 * Must be used after authMiddleware.
 */
function requireApproved(req, res, next) {
  if (req.user && req.user.role === 'PENDING') {
    return next(new ForbiddenError('Your account is awaiting admin approval'));
  }
  next();
}

/**
 * May this user approve song mappings?
 *
 * ADMINs always may. Anyone else needs the canEditMapping flag, which is read
 * from the database rather than the token: the flag is granted and revoked by
 * hand, and a token issued before a revocation would otherwise keep working
 * for a week. One wrong approval changes what plays for everybody, so this
 * checks the current truth even though it costs a query.
 *
 * Shared by the middleware below and by routes that are open to everyone but
 * answer an editor more fully.
 */
async function isMappingEditor(user) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { canEditMapping: true },
  });
  return !!row?.canEditMapping;
}

/** Middleware: refuse anyone who may not approve song mappings. */
async function requireMappingEditor(req, res, next) {
  try {
    if (!await isMappingEditor(req.user)) {
      return next(new ForbiddenError('Insufficient permissions'));
    }
    req.mappingEditor = true;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Middleware: record whether the caller may edit mappings, and let everyone
 * through either way.
 *
 * For the routes a listener and a reviewer both use, where the difference is
 * how much of the answer they get rather than whether they get one. Sets
 * `req.mappingEditor`; a route that forgets to check it simply answers as it
 * would for a listener, which is the safe direction to fail in.
 */
async function markMappingEditor(req, res, next) {
  try {
    req.mappingEditor = await isMappingEditor(req.user);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  authMiddleware, requireRole, requireApproved, requireActiveSession,
  requireMappingEditor, markMappingEditor, isMappingEditor,
};
