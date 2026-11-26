const router = require('express').Router();
const prisma = require('../db/client');
const { consume, limitedError } = require('../services/rateGuard');

// GET /api/users/search — search users by username/email (for sharing)
router.get('/search', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.length < 2) {
      return res.json({ users: [] });
    }
    // Counted only when it is a real search: the box asks on every pause in
    // typing, and the first letter alone looks nothing up.
    if (consume(req.user, 'userSearch', null)) return next(limitedError());

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
