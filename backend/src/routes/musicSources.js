const router = require('express').Router();
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const { ValidationError } = require('../utils/errors');
const svc = require('../services/musicCredentialService');
const qqLogin = require('../services/sources/qqLogin');
const qqAppQr = require('../services/sources/qqAppQrLogin');
const access = require('../services/musicCredentialAccess');

/**
 * The user's own QQ / NetEase credentials.
 *
 * Mounted behind auth, so every route here acts on req.user.id and takes no
 * user id from the caller — a credential belongs to exactly one account and
 * there is no reason for one user to name another.
 *
 * No route returns a stored cookie. GET reports connection state only. The
 * decrypted value leaves the server solely on outbound calls to the platform.
 */

// Saving is deliberately slow. A cookie is pasted once and then rarely, so a
// tight limit costs nothing legitimate while ruling out using this endpoint to
// grind through candidate values.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: '操作过于频繁，请稍后再试' } },
});

const platformParam = z.enum(['qq', 'netease']);

/**
 * Reject an unknown platform as a bad request rather than letting a raw
 * ZodError escape as a 500 — the caller sent a wrong value, the server is fine.
 */
function readPlatform(req) {
  const parsed = platformParam.safeParse(req.params.platform);
  if (!parsed.success) throw new ValidationError({ platform: ['未知的音乐平台'] });
  return parsed.data;
}

const setSchema = z.object({
  // Generous, because the user pastes a whole cookie header: a NetEase
  // MUSIC_U alone runs several hundred characters.
  cookie: z.string().min(1).max(8000),
});

// GET /api/music-sources — connection state for every platform
router.get('/', async (req, res, next) => {
  try {
    res.json({ sources: await svc.getStatus(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/music-sources/:platform
router.get('/:platform', async (req, res, next) => {
  try {
    const platform = readPlatform(req);
    res.json({ source: await svc.getStatus(req.user.id, platform) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/music-sources/:platform — store or replace a credential
router.put('/:platform', writeLimiter, validate(setSchema), async (req, res, next) => {
  try {
    const platform = readPlatform(req);
    await svc.setCredential(req.user.id, platform, req.validated.cookie);
    // Ask the platform whether the credential actually works before answering.
    // A cookie that parses can still be dead, and finding that out here costs
    // one request but saves the user pasting again after playback fails.
    res.json({ source: (await access.verifyCredential(req.user.id, platform)) ?? await svc.getStatus(req.user.id, platform) });
  } catch (err) {
    next(err);
  }
});

/**
 * QR login, the preferred way to connect QQ Music.
 *
 * Worth the extra routes because only this path yields refresh_key, the field
 * that lets a credential renew itself. A pasted cookie never carries it, so
 * that route alone would mean re-pasting every few days.
 *
 * It leans on an endpoint QQ Music's web player uses rather than a documented
 * one, so it can break without warning — which is why pasting stays supported
 * and every failure here names itself clearly enough for the page to offer it.
 */

// Generating a QR costs an outbound request, so it is limited more tightly
// than polling. A user needs one every few minutes at most.
const qrLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: '请求过于频繁，请稍后再试' } },
});

/**
 * Which QR flow to run.
 *
 * A QQ Music account can be reached by scanning with WeChat or with QQ Music
 * itself. Scanning with the wrong one does not error — it quietly connects a
 * different, empty account — so this stays a visible choice.
 *
 * Scanning with QQ is deliberately absent. It cannot work from a server: the
 * flow ends at QQ Connect's authorize step, which signs its request with
 * g_tk = hash33(p_skey), and p_skey is only ever given to JavaScript running on
 * graph.qq.com. A live scan confirmed it — the login was accepted, no p_skey
 * was issued, and authorize bounced to the login page. The app-QR flow below
 * reaches the same accounts without any of that.
 *
 * Each provider is reduced to the same three steps; the differences (endpoints,
 * status codes, how many hops the exchange takes) stay inside the modules.
 */
const PROVIDERS = {
  wechat: {
    createQrCode: () => qqLogin.createQrCode(),
    pollQrCode: (id) => qqLogin.pollQrCode(id),
    // WeChat's poll returns the OAuth code directly.
    exchange: (result) => qqLogin.exchangeCode(result.code),
  },
  qqmusic: {
    createQrCode: () => qqAppQr.createQrCode(),
    pollQrCode: (id) => qqAppQr.pollQrCode(id),
    // Already a credential; no OAuth code changes hands in this flow.
    exchange: (result) => qqAppQr.exchangeCode(result),
  },
};

/**
 * Default to WeChat when unspecified, so the URLs that existed before this
 * choice was offered keep behaving exactly as they did.
 */
function readProvider(req) {
  const parsed = z.enum(['wechat', 'qqmusic']).safeParse(req.query.provider || 'wechat');
  if (!parsed.success) throw new ValidationError({ provider: ['未知的扫码方式'] });
  return PROVIDERS[parsed.data];
}

// POST /api/music-sources/qq/qrcode[?provider=wechat|qqmusic] — start a QR login
router.post('/qq/qrcode', qrLimiter, async (req, res, next) => {
  try {
    res.json(await readProvider(req).createQrCode());
  } catch (err) {
    if (err.code === 'QR_SHAPE_CHANGED' || err.code === 'QR_UNAVAILABLE') {
      return res.status(503).json({ error: { message: err.message, code: err.code } });
    }
    return next(err);
  }
});

/**
 * GET /api/music-sources/qq/qrcode/:uuid — has it been scanned?
 *
 * WeChat holds the connection open until something happens, so "waiting" is the
 * normal answer and the browser simply calls again. QQ Music answers
 * immediately instead, so the browser's own interval sets the pace there.
 *
 * The provider must match the one that created the code: the identifier is a
 * WeChat uuid or a QQ Music qrcodeID, and they are not interchangeable.
 *
 * On success the credential is stored here, server side, and the browser is
 * told only that it worked.
 */
router.get('/qq/qrcode/:uuid', async (req, res, next) => {
  try {
    const provider = readProvider(req);
    // safeParse, not parse: a raw ZodError escapes as a 500, which reads as a
    // server fault when the caller merely sent a malformed id.
    const parsed = z.string().min(1).max(200).safeParse(req.params.uuid);
    if (!parsed.success) throw new ValidationError({ uuid: ['二维码标识无效'] });
    const result = await provider.pollQrCode(parsed.data);

    if (result.status !== 'done') {
      return res.json({ status: result.status });
    }

    const cred = await provider.exchange(result);
    // Every field the renewal call needs is stored now. Storing only what
    // playback uses would leave the first renewal to fail three days later,
    // when the key is already dying and there is no way to recover it.
    const source = await svc.setCredential(req.user.id, 'qq', cred.cookie, {
      method: 'qr',
      uin: cred.uin,
      loginType: cred.loginType,
      accessToken: cred.accessToken,
      refreshKey: cred.refreshKey,
      refreshToken: cred.refreshToken,
      openid: cred.openid,
      unionid: cred.unionid,
      strMusicId: cred.strMusicId,
      nickname: cred.nickname,
      expiresAt: cred.expiresAt,
      needRefreshInSec: cred.needRefreshInSec,
    });
    // Verified right away so the page can say whether this account has a
    // subscription — the difference between most songs playing and most not.
    return res.json({ status: 'done', source: (await access.verifyCredential(req.user.id, 'qq')) ?? source });
  } catch (err) {
    if (err.code === 'QR_LOGIN_FAILED' || err.code === 'QR_BAD_RESPONSE') {
      // The redirect trail is the only record of which hop refused, and it is
      // gone once the response is sent. Logged, not returned: it describes the
      // user's own login attempt and the page has no use for it.
      if (err.trail || err.detail) {
        console.warn('[qq-qr] %s: %s', err.code, err.trail || err.detail);
      }
      return res.status(502).json({ error: { message: err.message, code: err.code } });
    }
    return next(err);
  }
});

/**
 * POST /api/music-sources/qq/refresh — renew before the key dies.
 *
 * Only a scanned credential can do this; a pasted one has no refresh key and
 * is told so plainly, because the fix is different (reconnect by scanning).
 *
 * A refusal from the platform means the chain is broken for good — the stored
 * key can no longer mint a new one — so the failure is recorded and the user
 * is asked to rescan rather than being retried on a schedule.
 */
router.post('/qq/refresh', writeLimiter, async (req, res, next) => {
  try {
    const saved = await svc.getRefreshable(req.user.id, 'qq');
    if (!saved) {
      return res.status(400).json({
        error: { message: '这份连接不支持自动续期，请改用扫码连接', code: 'NOT_REFRESHABLE' },
      });
    }

    const fresh = await qqLogin.refreshCredential(saved);
    const source = await svc.setCredential(req.user.id, 'qq', fresh.cookie, {
      method: 'qr',
      uin: fresh.uin,
      loginType: fresh.loginType,
      accessToken: fresh.accessToken,
      refreshKey: fresh.refreshKey,
      refreshToken: fresh.refreshToken,
      openid: fresh.openid,
      unionid: fresh.unionid,
      strMusicId: fresh.strMusicId,
      nickname: fresh.nickname,
      expiresAt: fresh.expiresAt,
      needRefreshInSec: fresh.needRefreshInSec,
    });
    return res.json({ source: (await access.verifyCredential(req.user.id, 'qq')) ?? source });
  } catch (err) {
    if (err.code === 'QR_REFRESH_FAILED' || err.code === 'QR_NOT_REFRESHABLE') {
      await svc.recordCheck(req.user.id, 'qq', { ok: false, error: err.message })
        .catch(() => { /* the response matters more than the bookkeeping */ });
      return res.status(400).json({ error: { message: err.message, code: err.code } });
    }
    return next(err);
  }
});

// DELETE /api/music-sources/:platform
router.delete('/:platform', async (req, res, next) => {
  try {
    const platform = readPlatform(req);
    res.json({ source: await svc.clearCredential(req.user.id, platform) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
