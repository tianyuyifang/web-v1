const router = require('express').Router();
const adminService = require('../services/adminService');
const settingsService = require('../services/settingsService');
const validate = require('../middleware/validate');
const { updateBillingSchema } = require('../validators/billing');

// All routes here already have authMiddleware + requireRole('ADMIN') applied in server.js

// GET /api/admin/users — list all users
router.get('/users', async (req, res, next) => {
  try {
    const users = await adminService.listUsers();
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/pending — list pending users only
router.get('/users/pending', async (req, res, next) => {
  try {
    const users = await adminService.listPending();
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/approve — promote to MEMBER
router.patch('/users/:id/approve', async (req, res, next) => {
  try {
    const user = await adminService.approveUser(req.params.id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/guest — move to the limited GUEST tier
router.patch('/users/:id/guest', async (req, res, next) => {
  try {
    const user = await adminService.makeGuest(req.params.id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/demote — revert to PENDING
router.patch('/users/:id/demote', async (req, res, next) => {
  try {
    const user = await adminService.demoteUser(req.params.id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/users/:id — delete user
router.delete('/users/:id', async (req, res, next) => {
  try {
    await adminService.deleteUser(req.params.id, req.user.id);
    res.json({ message: 'User deleted' });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:id/playlists — list all playlists owned by a user (admin view-and-copy)
router.get('/users/:id/playlists', async (req, res, next) => {
  try {
    const result = await adminService.listUserPlaylists(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/bandwidth?days=30 — bandwidth usage per user
router.get('/bandwidth', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const stats = await adminService.getBandwidthStats(days);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/live-usage — who has been using 唱卡 this week
//
// No parameters: the window is fixed at seven days because that is what the
// data supports. Capture events are pruned after thirty, so an adjustable
// window would offer ranges it cannot actually answer.
router.get('/live-usage', async (req, res, next) => {
  try {
    res.json(await adminService.getLiveUsage());
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/tagging-usage — who is tagging songs, by hand or automatically
//
// Counted from likes, which both routes write identically, so the total covers
// manual tagging and 自动打标 together. No parameters: ten days.
router.get('/tagging-usage', async (req, res, next) => {
  try {
    res.json(await adminService.getTaggingUsage());
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/billing — update billing fields
router.patch('/users/:id/billing', validate(updateBillingSchema), async (req, res, next) => {
  try {
    const user = await adminService.updateBilling(req.params.id, req.validated);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/extend — extend subscription by one month
router.post('/users/:id/extend', async (req, res, next) => {
  try {
    const user = await adminService.extendOneMonth(req.params.id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/reset-password — set a new temp password, returned once
router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const result = await adminService.resetPassword(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/signup-promo — the campaign as configured, plus whether it is
// live right now. The two differ once the end date passes, and the admin page
// needs to show both: what was set, and what it is actually doing.
router.get('/signup-promo', async (req, res, next) => {
  try {
    const promo = await settingsService.getSignupPromo();
    const resolved = await settingsService.resolveSignupPromo();
    res.json({ promo, active: resolved.active });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/signup-promo — start, stop, or reconfigure the campaign
router.put('/signup-promo', async (req, res, next) => {
  try {
    const promo = await settingsService.setSignupPromo(req.body || {});
    const resolved = await settingsService.resolveSignupPromo();
    res.json({ promo, active: resolved.active });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
