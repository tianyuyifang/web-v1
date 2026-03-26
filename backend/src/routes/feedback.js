const router = require('express').Router();
const prisma = require('../db/client');
const { requireRole } = require('../middleware/auth');

// POST /api/feedback — submit feedback (any approved user)
router.post('/', async (req, res, next) => {
  try {
    const { type, title, artist, message } = req.body;

    if (!['BAD_SONG', 'REQUEST_SONG', 'GENERAL'].includes(type)) {
      return res.status(400).json({ error: { message: 'Invalid feedback type' } });
    }

    if ((type === 'BAD_SONG' || type === 'REQUEST_SONG') && !title) {
      return res.status(400).json({ error: { message: 'Title is required for song feedback' } });
    }

    if ((type === 'BAD_SONG' || type === 'REQUEST_SONG') && !artist) {
      return res.status(400).json({ error: { message: 'Artist is required for song feedback' } });
    }

    if (type === 'GENERAL' && !message) {
      return res.status(400).json({ error: { message: 'Message is required for general feedback' } });
    }

    const feedback = await prisma.feedback.create({
      data: {
        userId: req.user.id,
        type,
        title: title || null,
        artist: artist || null,
        message: message || null,
      },
    });

    res.status(201).json({ feedback });
  } catch (err) {
    next(err);
  }
});

// GET /api/feedback — list all feedback (admin only)
router.get('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const feedback = await prisma.feedback.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, username: true } },
      },
    });
    res.json({ feedback });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/feedback/:id — delete feedback (admin only)
router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    await prisma.feedback.delete({ where: { id: req.params.id } });
    res.json({ message: 'Feedback deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
