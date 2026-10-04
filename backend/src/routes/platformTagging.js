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
const { ValidationError } = require('../utils/errors');
const { searchTextFor } = require('../utils/searchText');
const requireAddOn = require('../middleware/requireAddOn');
const captureService = require('../services/captureService');
const likes = require('../services/platformLikeService');
const apkLikes = require('../services/apkLikeService');
const tags = require('../services/platformTagService');
const { addClient } = require('../services/sseManager');
const noEtag = require('../middleware/noEtag');
const { z } = require('zod');
const settingsService = require('../services/settingsService');
const credentials = require('../services/musicCredentialService');
const { getFreshCredential } = require('../services/musicCredentialAccess');
const meter = require('../services/outboundMeter');

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
    const playlists = await likes.listPlaylists(req.user.id, platform);
    // Pinyin for the name, so the list is searchable by initials too.
    res.json({ playlists: playlists.map((p) => ({ ...p, searchText: searchTextFor(p.name) })) });
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
    // isLikes: whether this is the favourites list, as the listing said. Cache
    // bookkeeping only (which entry a like invalidates), never a write.
    const isLikes = req.query.isLikes === '1' || req.query.isLikes === 'true';
    // cachedOnly: the page in 用户 IP mode asks for what is already here
    // before reading the list from the browser again -- never a platform read.
    if (req.query.cachedOnly === '1') {
      const hit = tags.cachedPlaylistWithLiked(req.user.id, ref);
      return hit ? res.json(hit) : res.status(204).end();
    }
    return res.json(await tags.playlistWithLiked(req.user.id, ref, Number.isInteger(dirId) ? dirId : null, isLikes));
  } catch (err) {
    next(err);
  }
});

// --- 用户 IP reads ---------------------------------------------------------
//
// When 档位设置 → QQ 播放解析 is 用户 IP for this user, the page reads its QQ
// lists from the user's own browser (lib/qqTagReads) instead of this server:
// the same calls, answered to the user's own address. These three routes are
// all the server does for it -- hand over the account values the reads need
// (never the cookie), and take back what was read. Anything that fails on the
// way, the page asks the routes above, as before.

const readLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { error: { message: '操作过于频繁，请稍后再试', status: 429 } },
});

/** Calls the browser says it made to QQ, for the outbound meter's user-IP column. */
function countUserIpCalls(body) {
  const n = Number(body && body.calls);
  // A 5000-song list is 5 pages plus 100 liked-state batches.
  if (Number.isInteger(n) && n > 0) meter.recordUserIp('qq', Math.min(n, 120));
}

/** Browser-read data is taken only while the user is in 用户 IP mode. */
async function browserMode(req) {
  const s = await settingsService.qqDirectFor(req.user.role);
  return s.mode === 'browser';
}

function notBrowserMode(res) {
  // The page falls back to the server's read on any refusal.
  return res.status(409).json({ error: { message: 'Lists are read by the server', status: 409 } });
}

/**
 * The browser read as the account connected now. A page holds its account
 * values for a few minutes; if the user connected another QQ account in the
 * meantime, what it read belongs to the old one and must not be kept for the
 * new one (its lists, or its euin stored on the new credential).
 */
async function sameAccount(req, uin) {
  const cred = await credentials.getCredential(req.user.id, 'qq');
  return Boolean(cred && cred.uin && String(cred.uin) === uin);
}

function otherAccount(res) {
  // The page drops its account values and asks again.
  return res.status(409).json({ error: { message: 'QQ account changed', status: 409, code: 'ACCOUNT_CHANGED' } });
}

// GET /api/platform-tagging/qq-read-session — the account values for reading
// this user's QQ lists from their browser, or { mode: 'server' }.
router.get('/qq-read-session', ...web, readLimiter, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const s = await settingsService.qqDirectFor(req.user.role);
    if (s.mode !== 'browser') return res.json({ mode: 'server' });
    const cred = await getFreshCredential(req.user.id, 'qq');
    if (!cred || !cred.uin || !cred.musicKey) return res.json({ mode: 'server', reason: 'no-credential' });
    return res.json({
      mode: 'browser',
      uin: String(cred.uin),
      musicKey: cred.musicKey,
      // Not a secret: the account's public id, needed for its collected lists.
      euin: cred.euin || null,
    });
  } catch (err) {
    return next(err);
  }
});

const listedPlaylist = z.object({
  ref: z.string().regex(/^qq:[A-Za-z0-9_-]{1,64}$/),
  id: z.string().max(64),
  dirId: z.number().int().nullable(),
  name: z.string().max(200),
  count: z.number().int().min(0).nullable(),
  cover: z.string().max(500).nullable(),
  isLikes: z.boolean(),
  kind: z.enum(['created', 'collected']),
});
const accountUin = z.string().regex(/^\d{1,20}$/);
const annotateBody = z.object({
  uin: accountUin,
  playlists: z.array(listedPlaylist).max(2000),
  euin: z.string().regex(/^[A-Za-z0-9_*+=/-]{4,100}$/).nullable().optional(),
  calls: z.number().int().optional(),
});

// POST /api/platform-tagging/playlists/annotate — the listing the browser read,
// given the same search text the server-read listing carries.
router.post('/playlists/annotate', ...web, readLimiter, async (req, res, next) => {
  try {
    if (!(await browserMode(req))) return notBrowserMode(res);
    const parsed = annotateBody.safeParse(req.body || {});
    if (!parsed.success) throw new ValidationError(parsed.error.flatten().fieldErrors);
    const { playlists, euin, uin } = parsed.data;
    countUserIpCalls(req.body);
    if (!(await sameAccount(req, uin))) return otherAccount(res);
    // Resolved off a playlist by the browser: keep it, as the server read does.
    if (euin) credentials.setEncryptUin(req.user.id, 'qq', euin).catch(() => {});
    return res.json({ playlists: playlists.map((p) => ({ ...p, searchText: searchTextFor(p.name) })) });
  } catch (err) {
    return next(err);
  }
});

// One song as a row: [id, songType, mid, title, artist, durationSec, vipOnly].
// Rows rather than objects so a 5000-song list stays well under nginx's 1 MB
// body limit (the field names alone were a third of it).
const suppliedSong = z.tuple([
  z.string().regex(/^\d{1,20}$/),
  z.number().int().min(0).max(1000),
  z.string().max(40).nullable(),
  z.string().max(300),
  z.string().max(500),
  z.number().int().min(0).max(100000).nullable(),
  z.boolean(),
]);
const supplyBody = z.object({
  uin: accountUin,
  title: z.string().max(300).nullable(),
  rows: z.array(suppliedSong).max(5000),
  readMs: z.number().int().min(0).optional(),
  likedIds: z.array(z.string().regex(/^\d{1,20}$/)).max(5000),
  dirId: z.number().int().nullable().optional(),
  isLikes: z.boolean().optional(),
  calls: z.number().int().optional(),
});

// POST /api/platform-tagging/playlists/:ref/supply — one list's songs and
// liked state as the browser read them. Answers like GET .../songs.
router.post('/playlists/:ref/supply', ...web, readLimiter, async (req, res, next) => {
  try {
    const { ref, platform } = likes.parseRef(req.params.ref);
    if (platform !== 'qq') throw new ValidationError({ playlistRef: ['只支持 QQ 歌单'] });
    if (!(await browserMode(req))) return notBrowserMode(res);
    const parsed = supplyBody.safeParse(req.body || {});
    if (!parsed.success) throw new ValidationError(parsed.error.flatten().fieldErrors);
    countUserIpCalls(req.body);
    const b = parsed.data;
    if (!(await sameAccount(req, b.uin))) return otherAccount(res);
    const songs = b.rows.map(([id, songType, mid, title, artist, durationSec, vipOnly]) => ({
      id, songType, mid, title, artist, durationSec, vipOnly,
    }));
    return res.json(tags.supplySongs(req.user.id, ref, {
      title: b.title,
      songs,
      likedIds: b.likedIds,
      dirId: b.dirId ?? null,
      isLikes: b.isLikes === true,
      readMs: b.readMs || 0,
    }));
  } catch (err) {
    return next(err);
  }
});

// POST /api/platform-tagging/refresh { playlistRef, dirId?, isLikes? }
// Re-read one list from the platform now. Limited like a write: it is a
// platform call the user triggers by hand.
router.post('/refresh', ...web, writeLimiter, async (req, res, next) => {
  try {
    const { playlistRef, dirId, isLikes } = req.body || {};
    res.json(await tags.refresh(
      req.user.id,
      likes.parseRef(playlistRef).ref,
      Number.isInteger(dirId) ? dirId : null,
      isLikes === true,
    ));
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
    const { playlistRef, dirId, isLikes } = req.body || {};
    const result = await tags.start({
      userId: req.user.id,
      playlistRef,
      dirId: Number.isInteger(dirId) ? dirId : null,
      isLikes: isLikes === true,
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
/**
 * Which platform a manual like/unlike is for. Everything is checked BEFORE
 * the write: a body refused after the platform has already changed would
 * leave the page and the cache disagreeing with the account. When a playlist
 * ref is given, the platform is the ref's -- a song id only means something
 * on the platform whose list it came from -- and a `platform` field that
 * disagrees with it is a bad request, not a tie to break.
 */
function likeTarget(body) {
  const { platform, id, songType, playlistRef } = body || {};
  let target = platform == null ? '' : String(platform);
  if (playlistRef) {
    const parsed = likes.parseRef(playlistRef);
    if (target && target !== parsed.platform) {
      throw new ValidationError({ platform: ['与歌单所属平台不一致'] });
    }
    target = parsed.platform;
  }
  return {
    platform: target,
    id: id == null ? null : String(id),
    songType: Number.isInteger(songType) ? songType : 0,
  };
}

// POST /api/platform-tagging/like { platform?, id, songType?, playlistRef? }
// A manual like from the playlist view. Not limited to exact matches: the
// user chose it.
router.post('/like', ...web, writeLimiter, async (req, res, next) => {
  try {
    const { platform, id, songType } = likeTarget(req.body);
    const result = await apkLikes.like(req.user.id, platform, { id, songType }, { purpose: 'manual' });
    tags.noteLiked(req.user.id, id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/platform-tagging/unlike { platform?, id, songType?, playlistRef? }
// The lit heart pressed again. Only the page reaches this; captures never do.
router.post('/unlike', ...web, writeLimiter, async (req, res, next) => {
  try {
    const { platform, id, songType } = likeTarget(req.body);
    const result = await apkLikes.unlike(req.user.id, platform, { id, songType }, { purpose: 'manual' });
    tags.noteUnliked(req.user.id, id);
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
// For tests: the one piece of request-shaping logic here worth checking alone.
module.exports.likeTarget = likeTarget;
