const router = require('express').Router();
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const svc = require('../services/musicCredentialService');

/**
 * The user's own QQ / NetEase credentials.
 *
 * Mounted behind auth, so every route here acts on req.user.id and takes no
 * user id from the caller — a credential belongs to exactly one account and
 * there is no reason for one user to name another.
 *
 * No route returns a stored cookie. GET reports connection state only. The
 * decrypted value leaves the server solely on outbound calls to the platform.
 */

// Saving is deliberately slow. A cookie is pasted once and then rarely, so a
// tight limit costs nothing legitimate while ruling out using this endpoint to
// grind through candidate values.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: '操作过于频繁，请稍后再试' } },
});

const platformParam = z.enum(['qq', 'netease']);

const setSchema = z.object({
  // Generous, because the user pastes a whole cookie header: a NetEase
  // MUSIC_U alone runs several hundred characters.
  cookie: z.string().min(1).max(8000),
});

// GET /api/music-sources — connection state for every platform
router.get('/', async (req, res, next) => {
  try {
    res.json({ sources: await svc.getStatus(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/music-sources/:platform
router.get('/:platform', async (req, res, next) => {
  try {
    const platform = platformParam.parse(req.params.platform);
    res.json({ source: await svc.getStatus(req.user.id, platform) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/music-sources/:platform — store or replace a credential
router.put('/:platform', writeLimiter, validate(setSchema), async (req, res, next) => {
  try {
    const platform = platformParam.parse(req.params.platform);
    const source = await svc.setCredential(req.user.id, platform, req.validated.cookie);
    res.json({ source });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/music-sources/:platform
router.delete('/:platform', async (req, res, next) => {
  try {
    const platform = platformParam.parse(req.params.platform);
    res.json({ source: await svc.clearCredential(req.user.id, platform) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
