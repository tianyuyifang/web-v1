const router = require('express').Router();
const songService = require('../services/songService');
const { guard } = require('../services/rateGuard');

// The most one search returns. The pages ask for no more than this.
const SEARCH_PAGE = 50;

// GET /api/songs/search?q=&mine=1&offset= — ranked search (添加歌曲, the 歌曲 tab).
// mine=1: only songs in the caller's own playlists, each listing which ones;
// offset pages on.
// Must stay above /:id, which would take "search" for a song id.
router.get('/search', guard('search'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || SEARCH_PAGE, 1), SEARCH_PAGE);
    const mine = req.query.mine === '1';
    // Paging on is only for a search of the caller's own playlists (the 歌曲
    // tab, "显示更多"). A search of the whole library answers with its best
    // SEARCH_PAGE matches and nothing after them — the pages never ask for
    // more, and "search one letter, then walk every page" is how the library's
    // catalogue was copied out on 2026-11-25.
    const offset = mine ? Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 100000) : 0;
    const result = await songService.searchRanked(q, limit, req.user?.role, req.user?.id, mine, offset);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/songs/:id — song detail with clips
router.get('/:id', guard('detail', (req) => req.params.id), async (req, res, next) => {
  try {
    const song = await songService.getSongById(req.params.id, req.user?.role);
    res.json(song);
  } catch (err) {
    next(err);
  }
});

// GET /api/songs/:id/clips — all clips for a song (global + user's own)
router.get('/:id/clips', guard('songClips', (req) => req.params.id), async (req, res, next) => {
  try {
    const clips = await songService.getSongClips(req.params.id, req.user?.id, req.user?.role);
    res.json({ clips });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
