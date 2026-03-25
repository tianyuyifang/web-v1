const router = require('express').Router();
const prisma = require('../db/client');

// GET /api/users/search — search users by username/email (for sharing)
router.get('/search', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    if (q.length < 2) {
      return res.json({ users: [] });
    }

    const users = await prisma.user.findMany({
      where: {
        username: { contains: q, mode: 'insensitive' },
        NOT: { id: req.user.id },
      },
      select: { id: true, username: true },
      take: 10,
    });

    res.json(users);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
