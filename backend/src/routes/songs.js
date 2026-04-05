const router = require('express').Router();
const songService = require('../services/songService');

// GET /api/songs — search/browse songs with cursor pagination
router.get('/', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    const cursor = req.query.cursor || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const strict = req.query.strict === '1';

    const result = await songService.getSongs(q, cursor, limit, strict);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/songs/:id — song detail with clips
router.get('/:id', async (req, res, next) => {
  try {
    const song = await songService.getSongById(req.params.id);
    res.json(song);
  } catch (err) {
    next(err);
  }
});

// GET /api/songs/:id/clips — all clips for a song (global + user's own)
router.get('/:id/clips', async (req, res, next) => {
  try {
    const clips = await songService.getSongClips(req.params.id, req.user?.id, req.user?.role);
    res.json({ clips });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
