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

// GET /api/feedback/mine — this user's own feedback, with any reply.
//
// Declared before the '/:id' route below so "mine" is not taken for an id.
// Returns only the caller's rows: feedback is a private note to the admins,
// not a public board, and one user's song requests are not another's business.
router.get('/mine', async (req, res, next) => {
  try {
    const feedback = await prisma.feedback.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, type: true, title: true, artist: true, message: true,
        reply: true, repliedAt: true, createdAt: true,
      },
    });
    res.json({ feedback });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/feedback/:id/reply — write (or rewrite) the reply (admin only)
//
// An empty body clears the reply, which puts the item back to unanswered — the
// way to undo a reply sent by mistake, since there is no separate status to
// reset.
router.patch('/:id/reply', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const text = typeof req.body?.reply === 'string' ? req.body.reply.trim() : '';
    const cleared = text.length === 0;
    if (text.length > 1000) {
      return res.status(400).json({ error: { message: 'Reply is too long' } });
    }
    const feedback = await prisma.feedback.update({
      where: { id: req.params.id },
      data: {
        reply: cleared ? null : text,
        // Stamped together with the text so "replied" and "when" can never
        // disagree; cleared together for the same reason.
        repliedAt: cleared ? null : new Date(),
      },
      include: { user: { select: { id: true, username: true } } },
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
