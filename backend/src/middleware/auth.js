const jwt = require('jsonwebtoken');
const config = require('../config');
const prisma = require('../db/client');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');

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
 * Middleware: verify the JWT's sessionId matches the user's active session.
 * Returns 403 SESSION_REPLACED if the session was replaced by a new login.
 * Skips the check if the user has no activeSessionId (pre-migration login).
 * Should be used after authMiddleware.
 */
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
