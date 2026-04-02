const router = require('express').Router();
const adminService = require('../services/adminService');

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

module.exports = router;
