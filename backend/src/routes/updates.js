const router = require('express').Router();
const { requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createUpdateSchema, editUpdateSchema } = require('../validators/updates');
const updateService = require('../services/updateService');

// GET /api/updates — list all updates, newest first (any approved user)
router.get('/', async (req, res, next) => {
  try {
    const updates = await updateService.listUpdates();
    res.json({ updates });
  } catch (err) {
    next(err);
  }
});

// GET /api/updates/highlighted — the currently-highlighted update, or null (any approved user)
// NOTE: declared before '/:id' routes so "highlighted" isn't matched as an :id.
router.get('/highlighted', async (req, res, next) => {
  try {
    const update = await updateService.getHighlighted();
    res.json({ update });
  } catch (err) {
    next(err);
  }
});

// POST /api/updates — create an update (admin only)
router.post('/', requireRole('ADMIN'), validate(createUpdateSchema), async (req, res, next) => {
  try {
    const update = await updateService.createUpdate(req.validated);
    res.status(201).json({ update });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/updates/:id — edit an update (admin only)
router.patch('/:id', requireRole('ADMIN'), validate(editUpdateSchema), async (req, res, next) => {
  try {
    const update = await updateService.editUpdate(req.params.id, req.validated);
    res.json({ update });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/updates/:id — delete an update (admin only)
router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    await updateService.deleteUpdate(req.params.id);
    res.json({ message: 'Update deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/updates/:id/highlight — toggle highlight (admin only)
router.post('/:id/highlight', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const update = await updateService.toggleHighlight(req.params.id);
    res.json({ update });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
