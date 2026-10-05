/**
 * The two things a browser needs to ask QQ for a play URL itself, and the
 * place it reports how that went. See settingsService (QQ_DIRECT_KEY) for the
 * modes and qqDirectStats for what the reports are used for.
 *
 * Mounted behind authMiddleware + requireApproved + requireActiveSession.
 */
const router = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const settings = require('../services/settingsService');
const { getFreshCredential, renewAfterRejection } = require('../services/musicCredentialAccess');
const stats = require('../services/qqDirectStats');
const meter = require('../services/outboundMeter');
const prisma = require('../db/client');
const { ADD_ONS, hasAddOn } = require('../utils/entitlements');

/** Only the 唱卡 add-on reaches the page that uses this; nobody else is handed a key. */
async function canUseLive(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, entitlements: true, tier: true },
  });
  return !!user && hasAddOn(user, ADD_ONS.CAPTURE, await settings.getTiers());
}

const limiter = (max) => rateLimit({
  windowMs: 5 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { error: { message: '操作过于频繁，请稍后再试' } },
});

/**
 * GET /api/qq-direct/session — the mode that applies to this user, and, when
 * the browser is to call QQ itself, the two values that call carries: the QQ
 * account number and its music key. Only ever the caller's own, never stored
 * by the page beyond its memory, never cached on the way.
 *
 * The key is renewed first if it is about to lapse, exactly as the server path
 * does before using it, so the browser is not handed one that dies mid-song.
 */
// Generous: an open 唱卡 page asks for this when a non-server mode starts, every
// 30 minutes while it holds, and after QQ reports a dead key; one member may
// hold several devices and tabs. Hitting the cap only means the server path.
router.get('/session', limiter(240), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const s = await settings.qqDirectFor(req.user.role);
    if (s.mode === 'server') return res.json({ mode: 'server' });
    if (!(await canUseLive(req.user.id))) return res.json({ mode: 'server', reason: 'no-add-on' });

    const cred = await getFreshCredential(req.user.id, 'qq');
    if (!cred || !cred.uin || !cred.musicKey) {
      // No QQ connected: every QQ card answers with the server's own message.
      return res.json({ mode: 'server', reason: 'no-credential' });
    }
    return res.json({
      mode: s.mode,
      hedgeMs: s.hedgeMs,
      uin: String(cred.uin),
      musicKey: cred.musicKey,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/qq-direct/renew { usedKey } — QQ told the browser its key is dead.
 * The server renews it (a login call only the server can make) and the page
 * then fetches the new key and asks QQ again itself: the play URL is never
 * fetched from here. `renewed` false means nothing more can be done without a
 * new scan (refused before, or the key is minutes old and so not the cause).
 */
router.post('/renew', limiter(20), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const s = await settings.qqDirectFor(req.user.role);
    if (s.mode !== 'browser' || !(await canUseLive(req.user.id))) return res.json({ renewed: false });
    const usedKey = typeof req.body?.usedKey === 'string' ? req.body.usedKey.slice(0, 400) : null;
    const fresh = await renewAfterRejection(req.user.id, usedKey);
    return res.json({ renewed: !!(fresh && fresh.musicKey && fresh.musicKey !== usedKey) });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/qq-direct/report — a batch of samples from one page: how the
 * browser's own request went, how the server path went on the same device,
 * and which answer played. Also how many QQ calls the browser made, which is
 * what the user-IP column of the outbound meter counts.
 */
// A page sends at most one batch per ~20 s (or per 10 samples).
router.post('/report', limiter(30), async (req, res, next) => {
  try {
    // Nothing to report while the browser is not asking QQ, or from someone
    // who cannot reach 唱卡: a report then is either a page from before a
    // switch-off or not from the page at all.
    const s = await settings.qqDirectFor(req.user.role);
    if (s.mode === 'server' || !(await canUseLive(req.user.id))) return res.json({ ok: true, ignored: true });
  } catch (err) {
    return next(err);
  }
  const { calls } = stats.record(req.body && req.body.samples, {
    username: req.user.username,
    ua: req.headers['user-agent'] || '',
  });
  const extra = Math.max(0, Math.min(5, Math.floor(Number(req.body && req.body.calls) || 0)));
  meter.recordUserIp('qq', calls + extra);
  return res.json({ ok: true });
});

module.exports = router;
