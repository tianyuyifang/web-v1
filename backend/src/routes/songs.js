const router = require('express').Router();
const songService = require('../services/songService');

// GET /api/songs/search?q=&mine=1&offset= — ranked search (添加歌曲, the 歌曲 tab).
// mine=1 adds which of the caller's own playlists hold each song; offset pages on.
// Must stay above /:id, which would take "search" for a song id.
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 100000);
    const mine = req.query.mine === '1';
    const result = await songService.searchRanked(q, limit, req.user?.role, req.user?.id, mine, offset);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/songs?q=&strict=1 — what 添加片段 called before /search. Kept only so
// pages opened before a deploy keep working until they reload; remove after
// a release (no other caller: nginx logs show only those pages).
router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '');
    const result = await songService.searchRanked(q, 50, req.user?.role, req.user?.id);
    res.json({ songs: result.songs, nextCursor: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/songs/:id — song detail with clips
router.get('/:id', async (req, res, next) => {
  try {
    const song = await songService.getSongById(req.params.id, req.user?.role);
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
