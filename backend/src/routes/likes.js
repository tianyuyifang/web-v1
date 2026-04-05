const router = require('express').Router();
const likeService = require('../services/likeService');

// POST /api/likes/toggle — toggle like on a song within a playlist
router.post('/toggle', async (req, res, next) => {
  try {
    const { playlistId, songId } = req.body;
    const result = await likeService.toggleLike(req.user.id, playlistId, songId);
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
    const likes = playlistId
      ? await likeService.getPlaylistLikes(playlistId)
      : await likeService.getUserLikes(req.user.id);
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
