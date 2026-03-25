const jwt = require('jsonwebtoken');
const config = require('../config');
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
    req.user = { id: payload.sub, username: payload.username, role: payload.role };
    next();
  } catch (err) {
    next(new UnauthorizedError('Invalid or expired token'));
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

module.exports = { authMiddleware, requireRole, requireApproved };
