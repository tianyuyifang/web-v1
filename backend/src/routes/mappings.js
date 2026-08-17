const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { ValidationError, NotFoundError } = require('../utils/errors');
const svc = require('../services/mappingReviewService');
const qq = require('../services/sources/qqSource');
const credentials = require('../services/musicCredentialService');

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
 * GET /api/mappings/:id/preview — a URL to hear the track.
 *
 * Review is mostly listening: two seconds tells you whether the pairing is
 * right. The reviewer's own credential is used, and the URL goes to the
 * browser, which fetches the audio from the CDN directly — the audio never
 * passes through this server.
 */
router.get('/:id/preview', async (req, res, next) => {
  try {
    const mapping = await svc.get(mappingId(req));
    if (mapping.source === 'LOCAL') {
      // Local songs already have a streaming route; no external call needed.
      return res.json({ kind: 'local', songId: mapping.externalId, url: null });
    }
    if (mapping.source !== 'QQ') {
      return res.json({ kind: 'unsupported', url: null, reason: `${mapping.source} preview not implemented` });
    }

    const cred = await credentials.getCredential(req.user.id, 'qq');
    if (!cred) {
      return res.status(400).json({
        error: { message: '需要先在账号页连接 QQ 音乐才能试听' },
      });
    }

    const result = await qq.resolveUrl(mapping.externalId, {
      cookie: cred.cookie, uin: cred.uin, musicKey: cred.musicKey,
    });
    return res.json({ kind: 'external', url: result.url, reason: result.reason });
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

module.exports = router;
