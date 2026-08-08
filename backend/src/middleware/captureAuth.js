const { resolveSession } = require('../services/captureService');
const { UnauthorizedError } = require('../utils/errors');

/**
 * Authenticate by capture-session token, not the login JWT.
 *
 * Deliberately does not touch the user's device-session list. Going through
 * authMiddleware + requireActiveSession would consume a device slot and
 * evict the user's browser login (see the device limit in middleware/auth.js).
 */
async function captureAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    const token =
      (header && header.startsWith('Bearer ') ? header.slice(7) : null) ||
      req.headers['x-capture-token'] ||
      (req.body && req.body.token);

    const session = await resolveSession(token);
    if (!session) return next(new UnauthorizedError('Invalid or expired capture token'));

    req.captureSession = session;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = captureAuth;
