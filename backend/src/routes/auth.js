const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const { authMiddleware, requireActiveSession } = require('../middleware/auth');
const { registerSchema, loginSchema, changePasswordSchema, changeUsernameSchema, updatePreferencesSchema } = require('../validators/auth');
const authService = require('../services/authService');
const redeemService = require('../services/redeemService');

// Rate limit only login + register (brute-force targets).
// Other auth routes require a valid JWT so brute-force isn't a risk.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later' } },
});

// Tighter limit for redeem: an activation code is a guessable credential worth
// money, so cap attempts per IP hard (10 / 10 min, like the capture pair code)
// rather than the looser login limit. trust proxy is set so this is per real IP.
const redeemLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: '尝试次数过多，请稍后再试' } },
});

// POST /api/auth/register
router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
  try {
    const result = await authService.register(req.validated);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const result = await authService.login(req.validated);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/redeem — public. A lapsed/PENDING user (no token) renews their
// own account with an activation code: username + code in the body. Rate limited
// against code guessing. Errors carry codes like INVALID_CODE / CODE_USED /
// NO_USER — deliberately NOT ACCOUNT_DISABLED/PENDING_APPROVAL, which the
// frontend response interceptor would hijack into a login redirect.
router.post('/redeem', redeemLimiter, async (req, res, next) => {
  try {
    const { username, code } = req.body || {};
    const result = await redeemService.redeem(username, code);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/username
router.put('/username', authMiddleware, validate(changeUsernameSchema), async (req, res, next) => {
  try {
    const user = await authService.changeUsername(req.user.id, req.validated);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/password
router.put('/password', authMiddleware, validate(changePasswordSchema), async (req, res, next) => {
  try {
    await authService.changePassword(req.user.id, req.validated);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/preferences
router.put('/preferences', authMiddleware, validate(updatePreferencesSchema), async (req, res, next) => {
  try {
    const user = await authService.updatePreferences(req.user.id, req.validated.preferences);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/me
router.post('/me', authMiddleware, requireActiveSession, async (req, res, next) => {
  try {
    const user = await authService.getMe(req.user.id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh — silently refresh a token that's still valid (or expired < 24h)
router.post('/refresh', async (req, res, next) => {
  try {
    const result = await authService.refreshToken(req);
    res.json(result);
  } catch (err) {
    if (err.code === 'SESSION_REPLACED') {
      return res.status(403).json({
        error: { code: 'SESSION_REPLACED', message: err.message },
      });
    }
    next(err);
  }
});

module.exports = router;
