/**
 * WeChat QR login for QQ Music.
 *
 * Why this exists rather than the official flow: WeChat's documented website
 * login is standard OAuth2, where redirect_uri must be a domain you registered
 * and the token exchange needs your own appid and secret. That path would sign
 * a user into *our* application — it cannot produce a QQ Music credential. So
 * this borrows QQ Music's own web appid and speaks to the endpoint its web
 * player uses, which is not documented anywhere.
 *
 * The consequence is that this can stop working without notice —登录 endpoints
 * change more often than the music ones, and one of those was retired under us
 * earlier the same day. Pasting a cookie by hand stays supported for exactly
 * that reason; this is the nicer path, not the only one.
 *
 * What makes it worth the risk: the credential it returns carries refresh_key,
 * which a pasted cookie never contains. That field is the only way to renew a
 * credential automatically, so without QR login every user re-pastes every few
 * days.
 *
 * Verified end to end on 2026-08-17.
 */
const https = require('https');

const APPID = 'wx48db31d50e334801';
const REDIRECT = 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Poll outcomes, from the reference client's QRCodeLoginEvents.
 * These are WeChat's codes; QQ's own QR flow uses a different set.
 */
const WX_STATUS = {
  405: 'done',
  408: 'waiting',
  404: 'scanned',
  402: 'expired',
  403: 'refused',
};

function request(url, { headers = {}, method = 'GET', body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;

    // Destroying a request makes it emit ECONNRESET a moment later. Without
    // this guard that arrives after the promise has already settled, and the
    // stray rejection propagates as an unhandled error that takes down the
    // response we were in the middle of writing.
    let settled = false;
    const done = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const ok = done(resolve);
    const fail = done(reject);

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': UA,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        // A QR image is ~50 KB; anything past a megabyte is not a response we
        // asked for.
        if (size > 4 * 1024 * 1024) {
          req.destroy();
          fail(new Error('QQ login response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => ok({
        status: res.statusCode,
        buf: Buffer.concat(chunks),
        headers: res.headers,
      }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const err = new Error('timeout');
      err.code = 'QR_TIMEOUT';
      fail(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Start a login: fetch a QR code to show the user.
 *
 * Returns the image as a data URI so the browser can render it without a
 * second round trip, plus the uuid that identifies this attempt.
 *
 * The code expires in a few minutes and polling must begin straight away —
 * generating one, waiting, then polling produced `expired` in testing.
 */
async function createQrCode() {
  const params = new URLSearchParams({
    appid: APPID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'snsapi_login',
    state: 'STATE',
    href: 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect',
  });

  const page = await request(`https://open.weixin.qq.com/connect/qrconnect?${params}`);
  if (page.status !== 200) {
    const err = new Error('微信登录暂时不可用');
    err.code = 'QR_UNAVAILABLE';
    throw err;
  }

  const uuid = (page.buf.toString('utf8').match(/uuid=(.+?)"/) || [])[1];
  if (!uuid) {
    // The page shape changed — the flow needs re-deriving, and callers should
    // fall back to pasting a cookie rather than showing a broken dialog.
    const err = new Error('微信登录页面结构已变化，请改用手动粘贴');
    err.code = 'QR_SHAPE_CHANGED';
    throw err;
  }

  const img = await request(`https://open.weixin.qq.com/connect/qrcode/${uuid}`, {
    headers: { Referer: 'https://open.weixin.qq.com/connect/qrconnect' },
  });
  if (img.status !== 200 || !img.buf.length) {
    const err = new Error('二维码获取失败');
    err.code = 'QR_UNAVAILABLE';
    throw err;
  }

  const mime = img.headers['content-type'] || 'image/jpeg';
  return {
    uuid,
    image: `data:${mime};base64,${img.buf.toString('base64')}`,
    expiresInSec: 300,
  };
}

/**
 * Ask once whether the code has been scanned.
 *
 * WeChat holds this connection open until something happens — measured at ~16s
 * for a code nobody has touched. Waiting that long inside a request of our own
 * turned out to be a bad trade: the browser, or anything between it and here,
 * gives up first and the caller sees a connection reset rather than an answer.
 *
 * So the outbound wait is capped well below any sane client or proxy timeout.
 * Hitting that cap simply means "nothing yet", and the browser asks again —
 * which costs one cheap request every few seconds and never leaves a socket
 * hanging long enough for something else to kill it.
 */
const POLL_WAIT_MS = 5000;

async function pollQrCode(uuid) {
  let res;
  try {
    res = await request(
      `https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${encodeURIComponent(uuid)}&_=${Date.now()}`,
      { headers: { Referer: 'https://open.weixin.qq.com/' }, timeoutMs: POLL_WAIT_MS },
    );
  } catch (err) {
    if (err.code === 'QR_TIMEOUT') return { status: 'waiting', code: null };
    throw err;
  }

  const m = /window\.wx_errcode=(\d+);window\.wx_code='([^']*)'/.exec(res.buf.toString('utf8'));
  if (!m) return { status: 'waiting', code: null };

  const wxCode = Number(m[1]);
  return { status: WX_STATUS[wxCode] || 'waiting', code: m[2] || null, raw: wxCode };
}

/**
 * Trade an authorised WeChat code for a QQ Music credential.
 *
 * Returns the pieces the rest of the system needs, plus refresh_key — the
 * field that makes automatic renewal possible and that a pasted cookie
 * cannot provide.
 */
async function exchangeCode(code) {
  const res = await request('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { Referer: 'https://y.qq.com/' },
    body: {
      comm: {
        ct: 11, cv: 13020508, v: 13020508, tmeAppID: 'qqmusic',
        format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', tmeLoginType: 1,
      },
      req_1: {
        module: 'music.login.LoginServer',
        method: 'Login',
        param: { code, strAppid: APPID },
      },
    },
  });

  let json;
  try {
    json = JSON.parse(res.buf.toString('utf8'));
  } catch {
    const err = new Error('登录响应无法解析');
    err.code = 'QR_BAD_RESPONSE';
    throw err;
  }

  const data = json?.req_1?.data;
  if (json?.req_1?.code !== 0 || !data?.musickey) {
    const err = new Error(data?.errMsg || '登录失败，请重试');
    err.code = 'QR_LOGIN_FAILED';
    err.platformCode = json?.req_1?.code;
    throw err;
  }

  return shapeCredential(data);
}

/**
 * Normalise a login/refresh response into what the credential store keeps.
 *
 * Every field the renewal call needs is carried through, not just the ones
 * playback uses: a renewal that is missing openid or unionid is rejected, and
 * discovering that three days later — when the key has already died — is the
 * worst time to find out.
 */
function shapeCredential(data) {
  const uin = String(data.musicid || data.str_musicid || '');
  return {
    uin,
    musicKey: data.musickey,
    // The renewal payload, kept together because it is only ever used as a set.
    refreshKey: data.refresh_key || null,
    refreshToken: data.refresh_token || null,
    accessToken: data.access_token || null,
    openid: data.openid || null,
    unionid: data.unionid || null,
    strMusicId: data.str_musicid || uin || null,
    nickname: data.nick || null,
    // The platform states both outright, so neither is inferred from a
    // cookie's own expiry attribute.
    /**
     * When the music key itself dies.
     *
     * Deliberately NOT expired_at: that is the OAuth access_token's lifetime,
     * which came back as two hours and made a freshly scanned login look
     * nearly dead on arrival. The key is what playback uses, and the reference
     * client judges it as `musickeyCreateTime + keyExpiresIn` — so that is
     * what is stored here.
     */
    expiresAt: (data.musickeyCreateTime && data.keyExpiresIn)
      ? new Date((data.musickeyCreateTime + data.keyExpiresIn) * 1000).toISOString()
      : (data.expired_at ? new Date(data.expired_at * 1000).toISOString() : null),
    keyExpiresInSec: data.keyExpiresIn ?? null,
    musicKeyCreatedAt: data.musickeyCreateTime ?? null,
    // The platform's own advice on when to renew. Preferred over a margin of
    // our choosing, since only it knows the real schedule.
    needRefreshInSec: data.needRefreshKeyIn ?? null,
    // access_token expiry, kept only because the renewal call echoes it back.
    accessTokenExpiresAt: data.expired_at ?? null,
    // Assembled so the credential store keeps its existing shape: everything
    // downstream already expects a cookie string.
    cookie: [
      `qm_keyst=${data.musickey}`,
      `qqmusic_key=${data.musickey}`,
      `uin=${uin}`,
      `wxuin=${uin}`,
      'login_type=2',
      'tmeLoginType=1',
    ].join('; '),
  };
}

/**
 * Renew a credential before it expires.
 *
 * This is the entire reason QR login exists: only a scanned credential carries
 * refresh_key, and only refresh_key makes this call possible. Without it a
 * connection dies after roughly three days and the user has to reconnect by
 * hand.
 *
 * The parameter set is the one a WeChat login (tmeLoginType 1) requires. It is
 * not interchangeable with the QQ-login shape, which sends access_token and
 * musicid where this sends unionid and str_musicid.
 */
async function refreshCredential(saved) {
  if (!saved?.refreshKey || !saved?.musicKey) {
    const err = new Error('这份凭证不支持自动续期，请重新扫码');
    err.code = 'QR_NOT_REFRESHABLE';
    throw err;
  }

  const res = await request('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { Referer: 'https://y.qq.com/' },
    body: {
      comm: {
        ct: 11, cv: 13020508, v: 13020508, tmeAppID: 'qqmusic',
        format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', tmeLoginType: 1,
      },
      req_1: {
        module: 'music.login.LoginServer',
        method: 'Login',
        param: {
          openid: saved.openid,
          refresh_token: saved.refreshToken,
          str_musicid: saved.strMusicId || saved.uin,
          musickey: saved.musicKey,
          unionid: saved.unionid,
          refresh_key: saved.refreshKey,
          loginMode: 2,
        },
      },
    },
  });

  let json;
  try {
    json = JSON.parse(res.buf.toString('utf8'));
  } catch {
    const err = new Error('续期响应无法解析');
    err.code = 'QR_BAD_RESPONSE';
    throw err;
  }

  const data = json?.req_1?.data;
  if (json?.req_1?.code !== 0 || !data?.musickey) {
    // A refusal here means the chain is broken for good — the stored key can
    // no longer mint a new one — so callers stop trying and ask for a rescan
    // rather than retrying on a schedule.
    const err = new Error(data?.errMsg || '续期失败，请重新扫码连接');
    err.code = 'QR_REFRESH_FAILED';
    err.platformCode = json?.req_1?.code;
    throw err;
  }

  return shapeCredential(data);
}

module.exports = {
  createQrCode,
  pollQrCode,
  exchangeCode,
  refreshCredential,
  APPID,
  WX_STATUS,
};
