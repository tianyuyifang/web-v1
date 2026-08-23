const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { ValidationError, NotFoundError } = require('../utils/errors');
const prisma = require('../db/client');
const svc = require('../services/mappingReviewService');
const qq = require('../services/sources/qqSource');
const netease = require('../services/sources/neteaseLogin');
const { getFreshCredential, renewAfterRejection } = require('../services/musicCredentialAccess');
const credentials = require('../services/musicCredentialService');
const urlCache = require('../services/playbackUrlCache');

/**
 * Song-mapping review.
 *
 * Mounted behind requireMappingEditor, so every route here is already limited
 * to admins and the few people trusted with the flag. Nothing is exposed to
 * ordinary users: a mapping decides what plays for everybody, so one wrong
 * approval is site-wide.
 *
 * There is no route that lists the whole table. Thousands of rows are not
 * useful to scroll; the real question is always "what did the game just show
 * me", which is a search.
 */

const listQuery = z.object({
  bucket: z.enum(['confirmed', 'pending', 'unseen']).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().uuid().optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});

const approveBody = z.object({
  // Present when the reviewer is repointing the row at a different track
  // before approving it.
  source: z.enum(['LOCAL', 'QQ', 'NETEASE']).optional(),
  externalId: z.string().min(1).max(200).optional(),
  note: z.string().max(500).optional(),
});

/**
 * Resolve an optional `?source=&externalId=` override to a real pool track.
 *
 * Both the preview and the lyrics route accept one so a reviewer can audition
 * an alternative, and both must treat it the same way: it arrives from the
 * browser, so it is looked up rather than trusted — otherwise these become an
 * open proxy for the reviewer's own platform credential.
 *
 * The source is checked against the enum before it reaches Prisma. A value
 * outside it is a bad request, but findUnique throws a validation error for it
 * that surfaces as a 500.
 */
const SOURCE_VALUES = z.enum(['LOCAL', 'QQ', 'NETEASE']);

async function resolveOverride(req, fallback) {
  const wanted = req.query.source;
  const wantedId = req.query.externalId;
  if (!wanted || !wantedId) return fallback;

  const source = SOURCE_VALUES.safeParse(wanted);
  if (!source.success) throw new NotFoundError('Track');

  const known = await prisma.importedTrack.findUnique({
    where: { source_externalId: { source: source.data, externalId: String(wantedId) } },
    select: { source: true, externalId: true },
  });
  if (!known) throw new NotFoundError('Track');
  return { source: known.source, externalId: known.externalId };
}

const rejectBody = z.object({
  // Defaults to removing the pool track as well: that is what "不是这首" means,
  // and it is what stops the resolver choosing the same recording again.
  deleteTrack: z.boolean().optional().default(true),
});

const createBody = z.object({
  gameTitle: z.string().min(1).max(300),
  gameArtist: z.string().max(300).optional().default(''),
  source: z.enum(['LOCAL', 'QQ', 'NETEASE']),
  externalId: z.string().min(1).max(200),
  approved: z.boolean().optional(),
});

// GET /api/mappings/counts — the three tab totals
router.get('/counts', async (req, res, next) => {
  try {
    res.json(await svc.getCounts());
  } catch (err) {
    next(err);
  }
});

/**
 * Reject a malformed :id before it reaches Prisma.
 *
 * Prisma raises an internal error on a non-uuid, which surfaces as a 500 —
 * the wrong answer for what is simply a bad request, and noise in the logs.
 */
function mappingId(req) {
  const parsed = z.string().uuid().safeParse(req.params.id);
  if (!parsed.success) throw new NotFoundError('Mapping');
  return parsed.data;
}

// GET /api/mappings?bucket=pending&q=…&cursor=…
router.get('/', async (req, res, next) => {
  try {
    // safeParse, not parse: a raw ZodError escapes as a 500, so a mistyped
    // query string would read as a server fault rather than a bad request.
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten().fieldErrors);

    const { bucket, q, cursor, take } = parsed.data;
    const page = await svc.list({ bucket, query: q, cursor, take });
    res.json({ ...page, counts: await svc.getCounts() });
  } catch (err) {
    next(err);
  }
});

// GET /api/mappings/:id
router.get('/:id', async (req, res, next) => {
  try {
    res.json({ mapping: await svc.get(mappingId(req)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/mappings/:id/candidates — alternatives from the local pool
router.get('/:id/candidates', async (req, res, next) => {
  try {
    res.json({ candidates: await svc.candidatesFor(mappingId(req)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Turn a (source, id) pair into something the browser can play.
 *
 * Shared by both preview routes so an unclaimed track and an approved mapping
 * behave identically — the audio does not care whether anyone has vouched for
 * the pairing yet.
 *
 * The reviewer's own credential is used and the URL goes to the browser, which
 * fetches from the CDN directly; the audio never passes through this server.
 */
async function resolvePreview(userId, source, externalId, res) {
  if (source === 'LOCAL') {
    // Local songs already have a streaming route; no external call needed.
    return res.json({ kind: 'local', songId: externalId, url: null });
  }
  if (source === 'NETEASE') {
    return resolveNeteasePreview(userId, externalId, res);
  }
  if (source !== 'QQ') {
    return res.json({ kind: 'unsupported', url: null, reason: `${source} preview not implemented` });
  }

  // A URL resolved moments ago is still good, and re-asking costs a round trip
  // the listener waits through plus one more request against their account.
  const cached = urlCache.get(userId, 'QQ', externalId);
  if (cached) return res.json({ kind: 'external', url: cached.url, reason: null, cached: true });

  // Renews first if the key is close to dying, so a review session does not
  // stop working halfway through.
  const cred = await getFreshCredential(userId, 'qq');
  if (!cred) {
    return res.status(400).json({
      error: { message: '这首歌来自 QQ 音乐，需要先在账号页连接 QQ 音乐才能试听', code: 'NO_CREDENTIAL', platform: 'qq' },
    });
  }

  try {
    const result = await qq.resolveUrl(externalId, {
      cookie: cred.cookie, uin: cred.uin, musicKey: cred.musicKey,
    });

    // The platform refusing every track, free ones included, means the key is
    // dead rather than the song being restricted. Renew once and try again —
    // a key can die earlier than the platform said it would, and the user
    // should not have to rescan for something we can fix silently.
    if (result.reason === 'credential-expired') {
      const renewed = await renewAfterRejection(userId);
      if (renewed) {
        const retry = await qq.resolveUrl(externalId, {
          cookie: renewed.cookie, uin: renewed.uin, musicKey: renewed.musicKey,
        });
        if (retry.url) {
          urlCache.set(userId, 'QQ', externalId, retry);
          return res.json({ kind: 'external', url: retry.url, reason: retry.reason });
        }
      }
      // Renewal did not help, so the chain really is broken.
      await credentials.recordCheck(userId, 'qq', { ok: false, error: 'musickey expired' })
        .catch(() => { /* bookkeeping only */ });
      return res.status(400).json({
        error: {
          message: 'QQ 音乐连接已失效，请到账号页重新扫码连接',
          code: 'CREDENTIAL_EXPIRED',
          platform: 'qq',
        },
      });
    }

    // Only successes are cached; a failure may be a credential the user is
    // about to fix, and caching it would make that look permanent.
    urlCache.set(userId, 'QQ', externalId, result);
    return res.json({ kind: 'external', url: result.url, reason: result.reason });
  } catch (err) {
    // A dead credential is the likeliest cause of a refusal here, and the user
    // can act on that — so it is reported as its own thing rather than as a
    // generic failure. Recorded too, so the account page agrees.
    if (err.code === 'SOURCE_RATE_LIMITED' || err.code === 'SOURCE_HTTP_ERROR') {
      await credentials.recordCheck(userId, 'qq', { ok: false, error: err.message })
        .catch(() => { /* bookkeeping only */ });
      return res.status(502).json({
        error: { message: 'QQ 音乐拒绝了这次请求，连接可能已失效，请去账号页重新连接', code: 'CREDENTIAL_REJECTED', platform: 'qq' },
      });
    }
    throw err;
  }
}

/**
 * The NetEase half of resolvePreview.
 *
 * Separate from the QQ path rather than folded into it: the two share a return
 * shape but nothing else — different credential, different failure codes, and
 * no renew-and-retry, because NetEase refuses the whole call when a cookie is
 * dead rather than refusing track by track.
 */
async function resolveNeteasePreview(userId, externalId, res) {
  const cached = urlCache.get(userId, 'NETEASE', externalId);
  if (cached) return res.json({ kind: 'external', url: cached.url, reason: null, cached: true });

  const cred = await getFreshCredential(userId, 'netease');
  if (!cred) {
    return res.status(400).json({
      error: {
        message: '这首歌来自网易云音乐，需要先在账号页连接网易云音乐才能试听',
        code: 'NO_CREDENTIAL',
        platform: 'netease',
      },
    });
  }

  const result = await netease.resolveUrl(externalId, { cookie: cred.cookie });

  if (result.reason === 'credential-expired') {
    await credentials.recordCheck(userId, 'netease', { ok: false, error: 'cookie expired' })
      .catch(() => { /* bookkeeping only */ });
    return res.status(400).json({
      error: {
        message: '网易云音乐连接已失效，请到账号页重新扫码连接',
        code: 'CREDENTIAL_EXPIRED',
        platform: 'netease',
      },
    });
  }

  /**
   * NetEase states the lifetime outright, so it is used rather than the
   * default — but shortened, since the clock started when the platform
   * answered and an entry that outlives its URL becomes a playback failure
   * the user cannot explain.
   */
  const ttl = result.expiresInSec ? result.expiresInSec * 500 : undefined;
  urlCache.set(userId, 'NETEASE', externalId, result, ttl);
  return res.json({ kind: 'external', url: result.url, reason: result.reason });
}

/**
 * GET /api/mappings/track/:trackId/preview — hear a track before claiming it.
 *
 * Listening is how you decide, so it has to come before the decision.
 * Requiring a claim first meant vouching for a pairing you had not heard,
 * which is backwards; every track in the pool came from a trusted playlist and
 * carries a real platform id, so there was never a reason to withhold it.
 */
router.get('/track/:trackId/preview', async (req, res, next) => {
  try {
    const parsed = z.string().uuid().safeParse(req.params.trackId);
    if (!parsed.success) throw new NotFoundError('Track');

    const track = await svc.getTrack(parsed.data);
    return await resolvePreview(req.user.id, track.source, track.externalId, res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/mappings/:id/preview — hear what a mapping resolves to.
 *
 * `source` and `externalId` may name a different track, so a reviewer can hear
 * an alternative before committing to it: two recordings of the same song can
 * open identically and only diverge at the chorus, and approving a version
 * nobody listened to is how the wrong one goes site-wide.
 *
 * The override is checked against the imported pool rather than trusted. It
 * arrives from the browser, and resolving whatever id it names would turn this
 * into an open proxy for the reviewer's own platform credential.
 */
router.get('/:id/preview', async (req, res, next) => {
  try {
    const mapping = await svc.get(mappingId(req));
    const { source, externalId } = await resolveOverride(req, mapping);
    return await resolvePreview(req.user.id, source, externalId, res);
  } catch (err) {
    next(err);
  }
});

/**
 * Lyrics for a (source, id) pair.
 *
 * No credential is needed — lyrics are public on both platforms — so this
 * answers even for a track the reviewer cannot play. That matters: knowing the
 * words is often how you tell a cover from the original when the audio itself
 * is withheld.
 *
 * A song without lyrics is ordinary, not an error, and comes back as a null
 * lyric so the page can say so plainly.
 */
async function resolveLyrics(source, externalId, res) {
  if (source === 'QQ') {
    const r = await qq.getLyric(externalId).catch(() => ({ lyric: null, translation: null }));
    return res.json({ lyric: r.lyric, translation: r.translation });
  }
  if (source === 'NETEASE') {
    const r = await netease.getLyric(externalId).catch(() => ({ lyric: null, translation: null }));
    return res.json({ lyric: r.lyric, translation: r.translation });
  }
  // LOCAL clips have their own lyrics route; anything else has none to give.
  return res.json({ lyric: null, translation: null });
}

/** GET /api/mappings/track/:trackId/lyrics */
router.get('/track/:trackId/lyrics', async (req, res, next) => {
  try {
    const parsed = z.string().uuid().safeParse(req.params.trackId);
    if (!parsed.success) throw new NotFoundError('Track');
    const track = await svc.getTrack(parsed.data);
    return await resolveLyrics(track.source, track.externalId, res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/mappings/:id/lyrics
 *
 * Takes the same optional `source`/`externalId` override as the preview route,
 * and for the same reason: while a reviewer auditions an alternative, the words
 * on screen have to be that recording's. Showing the original's lyrics against
 * a live version is worse than showing none — it invites the reviewer to
 * approve a pairing on evidence belonging to the other track.
 *
 * Checked against the imported pool rather than trusted, exactly as preview
 * does: the pair arrives from the browser.
 */
router.get('/:id/lyrics', async (req, res, next) => {
  try {
    const mapping = await svc.get(mappingId(req));
    const { source, externalId } = await resolveOverride(req, mapping);
    return await resolveLyrics(source, externalId, res);
  } catch (err) {
    next(err);
  }
});

// POST /api/mappings — claim a pool track for a game song
router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const mapping = await svc.createFromTrack({ ...req.validated, userId: req.user.id });
    res.json({ mapping, counts: await svc.getCounts() });
  } catch (err) {
    next(err);
  }
});

// POST /api/mappings/:id/approve
router.post('/:id/approve', validate(approveBody), async (req, res, next) => {
  try {
    const mapping = await svc.approve(mappingId(req), { ...req.validated, userId: req.user.id });
    res.json({ mapping, counts: await svc.getCounts() });
  } catch (err) {
    next(err);
  }
});

// POST /api/mappings/:id/unapprove — put it back in the queue
router.post('/:id/unapprove', async (req, res, next) => {
  try {
    const mapping = await svc.unapprove(mappingId(req));
    res.json({ mapping, counts: await svc.getCounts() });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mappings/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await svc.remove(mappingId(req));
    res.json({ ...result, counts: await svc.getCounts() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/mappings/:id/reject-impact — what "不是这首" would destroy.
 *
 * Read-only, and asked before the confirmation is shown: deleting a pool track
 * takes every mapping that names it, which the reviewer cannot know from the
 * row in front of them.
 */
router.get('/:id/reject-impact', async (req, res, next) => {
  try {
    res.json(await svc.rejectImpact(mappingId(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mappings/:id/reject — this recording does not belong in the
 * catalogue.
 *
 * A POST rather than another DELETE because it destroys more than the row it
 * names: the imported track goes too, which is the point — the resolver picks
 * from the pool, so removing the track is what stops it being chosen again.
 */
router.post('/:id/reject', validate(rejectBody), async (req, res, next) => {
  try {
    const result = await svc.reject(mappingId(req), {
      deleteTrack: req.validated.deleteTrack,
    });
    res.json({ ...result, counts: await svc.getCounts() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
