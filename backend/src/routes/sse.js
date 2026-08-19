const router = require('express').Router();
const prisma = require('../db/client');
const { addClient } = require('../services/sseManager');
const captureService = require('../services/captureService');

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

// GET /api/sse/capture/live/:sessionId — stream for a live (唱卡) run.
//
// Separate from the playlist stream because a live session has no playlist to
// key on. Ownership is checked here rather than trusting the id in the path:
// the channel name is derived from the authenticated user, so subscribing to
// someone else's session id still only ever joins your own channel.
router.get('/capture/live/:sessionId', async (req, res, next) => {
  try {
    const session = await prisma.captureSession.findUnique({
      where: { id: req.params.sessionId },
      select: { userId: true, mode: true },
    });
    if (!session) return res.status(404).end();
    if (session.userId !== req.user.id) return res.status(403).end();
    if (session.mode !== 'live') return res.status(400).end();

    addClient(captureService.liveChannel(req.user.id), res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
