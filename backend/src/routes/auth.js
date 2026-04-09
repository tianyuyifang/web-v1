const router = require('express').Router();
const validate = require('../middleware/validate');
const { authMiddleware } = require('../middleware/auth');
const { registerSchema, loginSchema, changePasswordSchema, changeUsernameSchema, updatePreferencesSchema } = require('../validators/auth');
const authService = require('../services/authService');

// POST /api/auth/register
router.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const result = await authService.register(req.validated);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const result = await authService.login(req.validated);
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
router.post('/me', authMiddleware, async (req, res, next) => {
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
    next(err);
  }
});

module.exports = router;
