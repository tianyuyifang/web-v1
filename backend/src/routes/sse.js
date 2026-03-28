const router = require('express').Router();
const prisma = require('../db/client');
const { addClient } = require('../services/sseManager');

// GET /api/sse/playlists/:id/likes — SSE stream for like events on a playlist
router.get('/playlists/:id/likes', async (req, res, next) => {
  try {
    const playlistId = req.params.id;
    const userId = req.user.id;

    // Verify playlist exists and user has view access
    const playlist = await prisma.playlist.findUnique({
      where: { id: playlistId },
      include: {
        shares: { where: { userId }, select: { id: true }, take: 1 },
        copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
      },
    });

    if (!playlist) return res.status(404).end();

    const isOwner = playlist.userId === userId;
    const isShared = playlist.shares.length > 0;
    const canCopy = playlist.copyPermissions.length > 0;
    const canView = isOwner || isShared || canCopy || playlist.isPublic;

    if (!canView) return res.status(403).end();

    addClient(playlistId, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
