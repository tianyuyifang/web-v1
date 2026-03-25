const router = require('express').Router();
const likeService = require('../services/likeService');

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

// GET /api/likes — get user's liked clips
router.get('/', async (req, res, next) => {
  try {
    const likes = await likeService.getUserLikes(req.user.id);
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
