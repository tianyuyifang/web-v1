/**
 * Gate a route on an add-on, read live from the database.
 *
 * Entitlements are not in the JWT: they change while a session is live, and
 * the tier config is edited from the admin page. So every call re-reads the
 * user row and the tier table. A factory, so a new add-on is one line in its
 * router rather than another copy of this function.
 *
 * routes/capture.js still carries its own hand-written copy of this check
 * (requireCaptureAddOn). It predates this file and is left as it is.
 */
const prisma = require('../db/client');
const { hasAddOn } = require('../utils/entitlements');
const settingsService = require('../services/settingsService');

function requireAddOn(addOn, message) {
  return async function requireAddOnMiddleware(req, res, next) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { role: true, entitlements: true, tier: true },
      });
      const tiers = await settingsService.getTiers();
      if (!hasAddOn(user, addOn, tiers)) {
        return res.status(403).json({
          error: { code: 'ADD_ON_REQUIRED', message, status: 403 },
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = requireAddOn;
