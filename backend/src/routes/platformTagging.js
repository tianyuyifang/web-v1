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
const { ValidationError, AppError } = require('../utils/errors');
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
const { getFreshCredential, renewAfterRejection } = require('../services/musicCredentialAccess');
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

/**
 * 网易云打标 is off unless an admin turns it on: NetEase can only be reached
 * from this server's address (2026-10-04). QQ打标 is always on and never
 * reaches QQ from here at all (platformLikeService refuses).
 */
async function assertPlatformOffered(platform) {
  if (platform !== 'netease') return;
  const s = await settingsService.getNeteaseTagging();
  if (!s.enabled) {
    const e = new AppError('网易云打标暂不提供', 403);
    e.code = 'NETEASE_TAGGING_OFF';
    throw e;
  }
}

// GET /api/platform-tagging/config — what the page may offer.
router.get('/config', ...web, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ netease: (await settingsService.getNeteaseTagging()).enabled });
  } catch (err) {
    next(err);
  }
});

// GET /api/platform-tagging/playlists?platform=qq|netease
// NetEase only: QQ lists are read by the user's browser (lib/qqTagReads) and
// a QQ listing here is refused (QQ_USER_IP_ONLY).
router.get('/playlists', ...web, async (req, res, next) => {
  try {
    const platform = String(req.query.platform || '');
    await assertPlatformOffered(platform);
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
    const { ref, platform } = likes.parseRef(req.params.ref);
    await assertPlatformOffered(platform);
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

// --- 用户 IP ------------------------------------------------------------------
//
// QQ打标 reads and writes QQ only from the user's own browser (lib/qqTagReads,
// lib/qqTagWrites) or phone -- never from here, and with no switch (2026-10-04).
// These routes are all the server does for it: hand over the account values
// the browser needs (never the cookie), take back what it read, and take
// part in the likes it performs.

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
// and writing this user's QQ from their browser; { mode: 'none' } when no QQ
// account is connected.
router.get('/qq-read-session', ...web, readLimiter, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const cred = await getFreshCredential(req.user.id, 'qq');
    if (!cred || !cred.uin || !cred.musicKey) return res.json({ mode: 'none', reason: 'no-credential' });
    return res.json({
      mode: 'browser',
      uin: String(cred.uin),
      musicKey: cred.musicKey,
      // 1 = WeChat, 2 = QQ account: what a write tells QQ in `comm`
      // (tmeLoginType). Read off the key the way QQ's own clients do; an
      // app-scan WeChat login answers to 1 too (tested 2026-10-04).
      loginType: String(cred.musicKey).startsWith('W_X') ? 1 : 2,
      // Not a secret: the account's public id, needed for its collected lists.
      euin: cred.euin || null,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/platform-tagging/renew { usedKey } — QQ told the browser its key is
// dead. The server renews it (a login, which only it can make; guarded by the
// same cooldown and minimum key age as every renewal) and the page fetches
// the new values and asks QQ again itself. `renewed` false: only a new scan helps.
router.post('/renew', ...web, readLimiter, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const usedKey = typeof req.body?.usedKey === 'string' ? req.body.usedKey.slice(0, 400) : null;
    const fresh = await renewAfterRejection(req.user.id, usedKey);
    return res.json({ renewed: !!(fresh && fresh.musicKey && fresh.musicKey !== usedKey) });
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

const recordedBody = z.object({
  op: z.enum(['like', 'unlike']),
  id: z.string().regex(/^\d{1,20}$/),
  calls: z.number().int().min(0).max(20).optional(),
});

// POST /api/platform-tagging/user-ip/recorded { op, id, calls } — the page
// liked or unliked a song itself (the heart), from the user's own address:
// every cached list learns it, as when the server used to do it.
router.post('/user-ip/recorded', ...web, writeLimiter, async (req, res, next) => {
  try {
    const parsed = recordedBody.safeParse(req.body || {});
    if (!parsed.success) throw new ValidationError(parsed.error.flatten().fieldErrors);
    const { op, id, calls } = parsed.data;
    if (calls) meter.recordUserIp('qq', calls);
    if (op === 'like') tags.noteLiked(req.user.id, id);
    else tags.noteUnliked(req.user.id, id);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/platform-tagging/user-ip/claim { cmdId } — a page takes an
// auto-like the server offered it on its stream (apkLikeService).
router.post('/user-ip/claim', ...web, async (req, res, next) => {
  try {
    const job = await apkLikes.claimPage(req.user.id, req.body && req.body.cmdId);
    if (!job) return res.status(409).json({ error: { message: 'Not yours to take', status: 409 } });
    return res.json(job);
  } catch (err) {
    return next(err);
  }
});

// POST /api/platform-tagging/user-ip/result { cmdId, ok, alreadyLiked?, code?, calls? }
router.post('/user-ip/result', ...web, async (req, res, next) => {
  try {
    const taken = apkLikes.resultPage(req.user.id, req.body && req.body.cmdId, req.body);
    return res.json({ ok: taken });
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
    await assertPlatformOffered(likes.parseRef(playlistRef).platform);
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
    await assertPlatformOffered(likes.parseRef(playlistRef).platform);
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
    const b = req.body || {};
    const br = b.browserResult;
    res.json(await tags.approve({
      userId: req.user.id,
      eventId: req.params.id,
      externalId: b.externalId,
      // QQ: written by the page from the user's own address; only reported here.
      browserResult: br && typeof br === 'object' && typeof br.ok === 'boolean'
        ? { ok: br.ok, alreadyLiked: br.alreadyLiked === true, message: typeof br.message === 'string' ? br.message : null }
        : null,
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
/**
 * A QQ heart reaching the server comes from a page loaded before 2026-10-04:
 * the current page writes QQ itself (lib/qqTagWrites) and only reports it.
 * The server does not write to QQ, so that page is told to reload.
 */
function refuseOldQqHeart(platform) {
  if (platform !== 'qq') return;
  const e = new AppError('请刷新页面后再点（QQ打标改为由你的浏览器点赞）', 409);
  e.code = 'QQ_USER_IP_ONLY';
  throw e;
}

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
    refuseOldQqHeart(platform);
    await assertPlatformOffered(platform);
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
    refuseOldQqHeart(platform);
    await assertPlatformOffered(platform);
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
    const executor = req.query.exec === '1';
    addClient(
      tags.channel(req.user.id),
      res,
      clientId ? `platform:${sessionId}:${clientId}${executor ? ':exec' : ''}` : undefined,
    );
    // A page that performs the auto-likes itself (lib/qqTagWrites).
    if (executor) apkLikes.attachPageExecutor(req.user.id, res);
    return undefined;
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
// For tests: the one piece of request-shaping logic here worth checking alone.
module.exports.likeTarget = likeTarget;
