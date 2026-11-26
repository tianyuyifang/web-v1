const router = require('express').Router();
const likeService = require('../services/likeService');
const { ForbiddenError, NotFoundError } = require('../utils/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/likes/toggle — toggle like on a clip within a playlist
router.post('/toggle', async (req, res, next) => {
  try {
    const { playlistId, clipId } = req.body;
    const result = await likeService.toggleLike(req.user.id, playlistId, clipId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/likes?playlistId=X — get liked clips for a playlist (shared pool)
// If no playlistId, returns likes across all accessible playlists
router.get('/', async (req, res, next) => {
  try {
    const { playlistId } = req.query;
    let likes;
    if (playlistId !== undefined) {
      // A string that is a playlist id, nothing else: `?playlistId[not]=x`
      // arrives as an object and used to go into the query as a filter.
      if (typeof playlistId !== 'string' || !UUID.test(playlistId)) throw new NotFoundError('Playlist');
      // Readable by whoever may open the playlist — the same people who see
      // these likes on its page.
      if (!(await likeService.canViewPlaylist(req.user.id, req.user.role, playlistId))) throw new ForbiddenError();
      likes = await likeService.getPlaylistLikes(playlistId);
    } else {
      likes = await likeService.getUserLikes(req.user.id);
    }
    res.json({ likes });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/likes/playlist/:playlistId — unlike all clips in a playlist
router.delete('/playlist/:playlistId', async (req, res, next) => {
  try {
    const result = await likeService.unlikeAllInPlaylist(req.user.id, req.params.playlistId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
