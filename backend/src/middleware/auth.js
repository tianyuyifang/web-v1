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
    const list = Array.isArray(activeSessions) ? activeSessions : [];
    if (list.length === 0) {
      return next();
    }
    if (!hasSession(list, req.user.sid)) {
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

module.exports = { authMiddleware, requireRole, requireApproved, requireActiveSession };
