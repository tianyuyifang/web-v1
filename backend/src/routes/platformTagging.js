/**
 * 平台打标 — the user's own QQ / NetEase playlists as a tagging target.
 *
 * Its own router, its own add-on. Nothing here touches our playlists or the
 * likes table; the only shared piece is the capture connection, which is
 * aimed from here the way the playlist page and 唱卡 aim it from theirs.
 *
 * Auth is per route: the stream must not hold a device slot (an EventSource
 * cannot send headers and stays open for hours), so it skips
 * requireActiveSession the same way /api/sse does. Everything else is a full
 * web request.
 */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const prisma = require('../db/client');
const { authMiddleware, requireApproved, requireActiveSession } = require('../middleware/auth');
const { ADD_ONS } = require('../utils/entitlements');
const requireAddOn = require('../middleware/requireAddOn');
const captureService = require('../services/captureService');
const likes = require('../services/platformLikeService');
const tags = require('../services/platformTagService');
const { addClient } = require('../services/sseManager');
const noEtag = require('../middleware/noEtag');

const requirePlatformTaggingAddOn = requireAddOn(
  ADD_ONS.PLATFORM_TAGGING,
  'QQ打标 is in closed beta',
);

const web = [authMiddleware, requireApproved, requireActiveSession, requirePlatformTaggingAddOn];

// Writes leave as the user against their own platform account. Thirty a
// minute is far more than a game produces and far less than a script would.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { error: { message: '操作过于频繁，请稍后再试', status: 429 } },
});

// GET /api/platform-tagging/playlists?platform=qq|netease
router.get('/playlists', ...web, async (req, res, next) => {
  try {
    const platform = String(req.query.platform || '');
    res.json({ playlists: await likes.listPlaylists(req.user.id, platform) });
  } catch (err) {
    next(err);
  }
});

// GET /api/platform-tagging/playlists/:ref/songs?dirId=
// Text only, plus whether each song is already in the user's 我喜欢. Served
// from the same cache the run reads, so clicking a list, starting, and
// clicking again is one platform read, not three.
router.get('/playlists/:ref/songs', ...web, async (req, res, next) => {
  try {
    const { ref } = likes.parseRef(req.params.ref);
    const dirId = req.query.dirId != null && req.query.dirId !== ''
      ? Number(req.query.dirId) : null;
    res.json(await tags.playlistWithLiked(req.user.id, ref, Number.isInteger(dirId) ? dirId : null));
  } catch (err) {
    next(err);
  }
});

// POST /api/platform-tagging/connect — open a capture connection.
// The same connection the playlist page and 唱卡 use; only the gate differs,
// so a beta user without the capture add-on can still pair a client.
router.post('/connect', ...web, async (req, res, next) => {
  try {
    const { label, ttlMinutes } = req.body || {};
    const { session, token } = await captureService.connect({
      userId: req.user.id, label, ttlMinutes,
    });
    res.json({
      token,
      pairCode: session.pairCode,
      pairExpiresAt: session.pairExpiresAt,
      session: {
        id: session.id,
        target: session.target,
        platformRef: session.platformRef,
        expiresAt: session.expiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/platform-tagging/start { playlistRef, dirId? } — aim at a playlist
router.post('/start', ...web, writeLimiter, async (req, res, next) => {
  try {
    const { playlistRef, dirId } = req.body || {};
    const result = await tags.start({
      userId: req.user.id,
      playlistRef,
      dirId: Number.isInteger(dirId) ? dirId : null,
    });
    res.json({
      session: {
        id: result.session.id,
        target: result.session.target,
        platformRef: result.session.platformRef,
        expiresAt: result.session.expiresAt,
      },
      playlist: result.playlist,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/platform-tagging/stop — stop delivering, keep the connection.
router.post('/stop', ...web, async (req, res, next) => {
  try {
    const { session } = await tags.stop({ userId: req.user.id });
    res.json({ session: { id: session.id, target: session.target, platformRef: session.platformRef } });
  } catch (err) {
    next(err);
  }
});

// GET /api/platform-tagging/feed?sessionId=
router.get('/feed', ...web, noEtag, async (req, res, next) => {
  try {
    res.json(await tags.getFeed({
      userId: req.user.id,
      sessionId: String(req.query.sessionId || ''),
      limit: Number(req.query.limit) || undefined,
    }));
  } catch (err) {
    next(err);
  }
});

// POST /api/platform-tagging/events/:id/approve { externalId? }
router.post('/events/:id/approve', ...web, writeLimiter, async (req, res, next) => {
  try {
    res.json(await tags.approve({
      userId: req.user.id,
      eventId: req.params.id,
      externalId: req.body && req.body.externalId,
    }));
  } catch (err) {
    next(err);
  }
});

// POST /api/platform-tagging/events/:id/ignore
router.post('/events/:id/ignore', ...web, async (req, res, next) => {
  try {
    res.json(await tags.ignore({ userId: req.user.id, eventId: req.params.id }));
  } catch (err) {
    next(err);
  }
});

// POST /api/platform-tagging/like { platform, id, songType? } — a manual like
// from the playlist view. Not limited to exact matches: the user chose it.
router.post('/like', ...web, writeLimiter, async (req, res, next) => {
  try {
    const { platform, id, songType } = req.body || {};
    const result = await likes.like(req.user.id, String(platform || ''), {
      id: id == null ? null : String(id),
      songType: Number.isInteger(songType) ? songType : 0,
    });
    tags.noteLiked(req.user.id, String(id));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/platform-tagging/stream?sessionId=&clientId=&token= — live feed.
// No requireActiveSession, for the reason at the top of this file. Keyed by
// session and page so a reconnect retires its predecessor (see /api/sse).
router.get('/stream', authMiddleware, requireApproved, requirePlatformTaggingAddOn, async (req, res, next) => {
  try {
    const sessionId = String(req.query.sessionId || '');
    // Reaches a uuid column; a malformed id is a 404 here, not a 500 there.
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(404).end();
    const session = await prisma.captureSession.findUnique({
      where: { id: sessionId }, select: { userId: true },
    });
    if (!session) return res.status(404).end();
    if (session.userId !== req.user.id) return res.status(403).end();

    const rawClientId = String(req.query.clientId || '');
    const clientId = /^[A-Za-z0-9]{1,32}$/.test(rawClientId) ? rawClientId : null;
    addClient(
      tags.channel(req.user.id),
      res,
      clientId ? `platform:${sessionId}:${clientId}` : undefined,
    );
    return undefined;
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
