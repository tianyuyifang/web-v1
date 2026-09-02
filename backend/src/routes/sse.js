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

    // Deliberately unkeyed: a playlist page legitimately holds more than one
    // stream on this endpoint at once — the likes hook opens one and the
    // 自动打标 panel opens its own beside it. Keying these by viewer made each
    // new one retire the other, so whichever connected last worked and the
    // other went silent until a refresh swapped them over. De-duplication is
    // for 唱卡, where a reconnecting page really is replacing itself.
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
      select: { userId: true },
    });
    if (!session) return res.status(404).end();
    if (session.userId !== req.user.id) return res.status(403).end();
    // Deliberately not gated on the session's current target. The target moves
    // while the connection runs, and EventSource treats a 400 as permanent --
    // so refusing here meant that aiming at a playlist and back left the 唱卡
    // stream dead until a full page reload, with nothing on screen to say why.
    // Nothing is leaked by allowing it: the channel is derived from the
    // authenticated user, so an idle subscription simply receives nothing.

    // Keyed by session *and page*: the 唱卡 page reconnects on its own whenever
    // it suspects the stream has gone quiet (a backgrounded phone, a network
    // switch), and each reconnect must retire the one before it rather than
    // leave a heartbeat running against a socket nobody reads.
    //
    // The page half matters as much as the session half. Keyed on the session
    // alone, a singer following along on a laptop and a phone had both pages
    // under one key, so each connection evicted the other — and being evicted
    // is what makes a page reconnect, which evicted the first right back. That
    // loop ran at roughly one reconnect every 6s in production and lost every
    // card pushed into a gap. It is the same shape as the July regression on
    // the playlist stream above, where two subscribers shared a key.
    //
    // An absent or malformed clientId falls back to a per-connection value, so
    // an older page (or a probe) never collides with anything — it simply opts
    // out of de-duplication, which is the safe direction.
    const rawClientId = String(req.query.clientId || '');
    const clientId = /^[A-Za-z0-9]{1,32}$/.test(rawClientId) ? rawClientId : null;
    addClient(
      captureService.liveChannel(req.user.id),
      res,
      clientId ? `live:${req.params.sessionId}:${clientId}` : undefined,
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
