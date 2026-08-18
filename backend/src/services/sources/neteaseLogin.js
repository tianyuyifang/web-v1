/**
 * NetEase Cloud Music QR login.
 *
 * Refreshingly ordinary compared to QQ Music: three POSTs, plain HTTP polling,
 * and a status that actually changes as the user scans. No MQTT, no OAuth
 * redirect chain, no value that only exists inside a browser.
 *
 * There is exactly one QR flow here. NetEase accounts are their own — not bound
 * to WeChat or QQ — so unlike QQ Music there is no choice of scanning app. The
 * other documented ways in (phone or email with a password, or an SMS code) are
 * deliberately not offered: they would have the user hand us a password or a
 * one-time code, and the point of scanning is that they never do.
 *
 * Request shapes are taken from the maintained reference implementation
 * (NeteaseCloudMusicApiEnhanced/api-enhanced, module/login_qr_*.js and
 * util/request.js) rather than reconstructed. The original Binaryify project is
 * archived and should not be followed.
 */
const crypto = require('crypto');
const https = require('https');
const QRCode = require('qrcode');

/**
 * eapi, the client-facing encryption.
 *
 * Chosen over weapi because it needs only AES-ECB and MD5, both in Node's
 * standard library. weapi additionally requires RSA with no padding, which
 * Node's publicEncrypt does not do cleanly.
 */
const EAPI_KEY = 'e82ckenh8dichen8';
const EAPI_HOST = 'interfacepc.music.163.com';
const TIMEOUT_MS = 12000;

/** Poll outcomes, from the reference implementation's documented codes. */
const QR_STATUS = {
  800: 'expired',
  801: 'waiting',
  802: 'scanned',
  803: 'done',
};

function aesEcbHex(text, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null);
  return Buffer
    .concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

function eapiParams(apiPath, payload) {
  const text = JSON.stringify(payload);
  const digest = crypto.createHash('md5')
    .update(`nobody${apiPath}use${text}md5forencrypt`)
    .digest('hex');
  return { params: aesEcbHex(`${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, EAPI_KEY) };
}

/**
 * The client identity every eapi call carries.
 *
 * It goes two places at once, which is the part that is easy to get wrong: the
 * object is folded into the payload *before* encryption as `header`, and the
 * same values are sent as the Cookie. Omitting either makes the call fail in
 * ways that do not name the cause.
 */
/**
 * A stable device identity for this server.
 *
 * Generated once per process rather than per request. The official client sends
 * the same deviceId every time — a value that changes on every call is a
 * clearer sign of automation than any single request could be, since no real
 * installation behaves that way.
 *
 * Not persisted: a restart mints a new one, which reads as a reinstall rather
 * than as many devices at once.
 */
const DEVICE_ID = crypto.randomBytes(16).toString('hex');

/**
 * The client identity every eapi call carries.
 *
 * It goes two places at once, which is the part that is easy to get wrong: the
 * object is folded into the payload *before* encryption as `header`, and the
 * same values are sent as the Cookie. Omitting either makes the call fail in
 * ways that do not name the cause.
 *
 * The values are the reference's osMap.pc set, kept coherent on purpose. An
 * earlier version claimed os "pc" while sending a mobile appver, an empty osver
 * and no deviceId, alongside a plain browser User-Agent — a combination no real
 * installation produces, and exactly the sort of mismatch a risk-control system
 * is built to notice.
 */
function clientHeader(extra = {}) {
  return {
    os: 'pc',
    appver: '3.1.17.204416',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    deviceId: DEVICE_ID,
    versioncode: '140',
    mobilename: '',
    buildver: String(Date.now()).slice(0, 10),
    resolution: '1920x1080',
    channel: 'netease',
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
    ...extra,
  };
}

function serialiseCookie(header) {
  return Object.entries(header)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('; ');
}

function fail(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * One eapi call.
 *
 * Note the path juggling: the request is *signed* against `/api/...` but
 * *sent* to `/eapi/...`. Signing the path it is sent to yields a valid-looking
 * request that the server rejects.
 */
function call(apiPath, data, { cookie = '' } = {}) {
  const header = clientHeader();
  const payload = { ...data, header };
  const body = Buffer.from(new URLSearchParams(eapiParams(apiPath, payload)).toString(), 'utf8');

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (v) => { if (!settled) { settled = true; fn(v); } };
    const ok = done(resolve);
    const bad = done(reject);

    const req = https.request({
      hostname: EAPI_HOST,
      path: apiPath.replace('/api/', '/eapi/'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body.length,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117',
        Referer: 'https://music.163.com',
        Cookie: cookie || serialiseCookie(header),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        // These responses are a couple of kilobytes at most.
        if (size > 4 * 1024 * 1024) {
          req.destroy();
          bad(fail('网易云响应过大', 'QR_BAD_RESPONSE'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          bad(fail('网易云响应无法解析', 'QR_BAD_RESPONSE'));
          return;
        }
        ok({ json, setCookie: res.headers['set-cookie'] || [] });
      });
      // A socket dying mid-body settles nothing without this.
      res.on('error', bad);
    });
    req.on('error', bad);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      bad(fail('网易云请求超时', 'QR_TIMEOUT'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Step 1 — a QR to display.
 *
 * NetEase hands back only a key; the image is ours to render, unlike QQ Music
 * which returns a PNG outright. The QR encodes the login URL the phone opens.
 */
async function createQrCode() {
  const { json } = await call('/api/login/qrcode/unikey', { type: 3 });
  if (json?.code !== 200 || !json?.unikey) {
    throw fail('网易云扫码暂时不可用', 'QR_UNAVAILABLE', { platformCode: json?.code });
  }

  const url = `https://music.163.com/login?codekey=${json.unikey}`;
  return {
    uuid: json.unikey,
    image: await QRCode.toDataURL(url),
    // Roughly five minutes in practice; surfaced so the page stops polling
    // rather than running against a dead key.
    expiresIn: 300,
  };
}

/**
 * Step 2 — has it been scanned?
 *
 * On success the credential arrives as Set-Cookie headers rather than in the
 * body, so they are collected here and handed on whole.
 */
async function pollQrCode(unikey) {
  const { json, setCookie } = await call('/api/login/qrcode/client/login', { key: unikey, type: 3 });
  const status = QR_STATUS[json?.code];

  if (!status) {
    throw fail(json?.message || '扫码状态查询失败', 'QR_BAD_RESPONSE', { platformCode: json?.code });
  }
  if (status !== 'done') return { status };

  const cookie = setCookie.map((line) => line.split(';')[0]).join('; ');
  if (!/MUSIC_U=/.test(cookie)) {
    throw fail('扫码成功但未能取得登录凭证', 'QR_BAD_RESPONSE');
  }
  return { status: 'done', cookie };
}

/**
 * Normalise into what the credential store keeps.
 *
 * NetEase states no expiry for MUSIC_U, so none is claimed here rather than
 * inventing one. What matters is that it is renewable: a scanned connection can
 * keep itself alive, where a pasted cookie cannot.
 */
function shapeCredential(cookie) {
  return {
    cookie,
    method: 'qr',
    refreshable: true,
    expiresAt: null,
  };
}

/**
 * Renew a credential before it lapses.
 *
 * Answers with fresh cookies on success; anything else means the chain is
 * broken and only a new scan can fix it.
 */
async function refreshCredential(cookie) {
  const { json, setCookie } = await call('/api/login/token/refresh', {}, { cookie });
  if (json?.code !== 200) {
    throw fail('网易云续期失败，请重新扫码连接', 'QR_REFRESH_FAILED', { platformCode: json?.code });
  }
  const fresh = setCookie.map((line) => line.split(';')[0]).join('; ');
  // The endpoint can answer 200 without reissuing anything; in that case the
  // existing cookie is still valid and is kept rather than blanked.
  return { cookie: /MUSIC_U=/.test(fresh) ? fresh : cookie };
}

/**
 * Who this credential belongs to, and whether the account has a subscription.
 *
 * The same call answers both, which is why it runs as soon as a credential is
 * stored: saving one only proves it parsed. /nuser/account/get is what the
 * official client uses for login status; the reference reaches it over weapi,
 * but eapi works too and needs no RSA — verified against a live credential.
 *
 * vipType is 0 for a free account and non-zero for a paying one (11 observed on
 * a real 黑胶VIP account). It is reported as-is rather than mapped to QQ's
 * 1/2 scale, since the tiers do not correspond.
 */
async function getAccountInfo(cookie) {
  const { json } = await call('/api/nuser/account/get', {}, { cookie });
  if (json?.code !== 200 || !json?.account) {
    return { ok: false, vipType: null, nickname: null };
  }
  return {
    ok: true,
    vipType: json.account.vipType ?? 0,
    nickname: json.profile?.nickname || null,
  };
}

/**
 * Make a playback URL fetchable by the browser.
 *
 * NetEase hands out hosts that do not send CORS — m704 and m804 among them —
 * and our player needs it: pitch shifting runs through AudioContext, which
 * means fetch + decodeAudioData, which is a CORS request. A plain <audio> tag
 * would play without it, but then there is no pitch shifting, and that is the
 * point of the feature.
 *
 * The same file is served with `access-control-allow-origin: *` by the 01 host
 * of the same numeric family. Verified byte-for-byte: identical sha256 over the
 * first 4 KB and identical total length.
 *
 * Only rewritten when CORS is actually missing. Some hosts (m10 was seen) send
 * it already, and rewriting those answers 403 — so this is a repair, not a
 * blanket redirect.
 */
function corsFriendlyUrl(rawUrl, hasCors) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  // The CDN serves both schemes; https keeps the page from mixing content.
  u.protocol = 'https:';
  if (hasCors) return u.toString();

  // m704 -> m701, m804 -> m801: same family, host 01. Parsed rather than
  // pattern-matched so an unfamiliar hostname is left alone instead of being
  // mangled into something that does not exist.
  const m = /^m(\d)\d*\.music\.126\.net$/.exec(u.hostname);
  if (m) u.hostname = `m${m[1]}01.music.126.net`;
  return u.toString();
}

/**
 * Ask whether a CDN host sends CORS, so the rewrite only fires when needed.
 *
 * One cheap ranged request — a hundred bytes — rather than assuming from the
 * hostname, because the set of hosts is not documented and guessing wrong
 * either breaks playback or breaks a URL that already worked.
 */
function hostSendsCors(rawUrl) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(rawUrl);
      u.protocol = 'https:';
    } catch {
      return resolve(false);
    }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Range: 'bytes=0-99', Origin: 'https://qnicheatsheet.com' },
    }, (res) => {
      res.resume();
      resolve(Boolean(res.headers['access-control-allow-origin']));
    });
    req.on('error', () => resolve(false));
    // Cheap check; if it is slow, assume the rewrite is needed rather than wait.
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Resolve a playback URL for one track.
 *
 * Shaped like the QQ resolver so callers can treat the two the same: a url on
 * success, or a null url with a reason. The audio itself is fetched by the
 * listener's browser straight from the CDN, which is what keeps this off our
 * bandwidth bill.
 */
async function resolveUrl(songId, { cookie, level = 'standard' } = {}) {
  if (!cookie) {
    const err = new Error('网易云需要登录凭证才能解析播放地址');
    err.code = 'SOURCE_NEEDS_CREDENTIAL';
    err.platform = 'netease';
    throw err;
  }

  const { json } = await call('/api/song/enhance/player/url/v1', {
    ids: JSON.stringify([String(songId)]),
    level,
    encodeType: 'flac',
  }, { cookie });

  // A dead cookie fails the whole call rather than one track.
  if (json?.code === 301 || json?.code === 401) {
    return { url: null, reason: 'credential-expired', platformResult: json.code };
  }

  const info = json?.data?.[0];
  if (!info?.url) {
    /**
     * fee 1 and 4 mark paid tracks, and a null url alongside them means the
     * account cannot play it rather than the track being gone. Saying which
     * matters: one is fixed by a subscription, the other never.
     */
    const needsVip = info?.fee === 1 || info?.fee === 4;
    return {
      url: null,
      reason: needsVip ? 'needs-vip' : 'unavailable',
      platformResult: info?.code ?? json?.code ?? null,
    };
  }

  const url = corsFriendlyUrl(info.url, await hostSendsCors(info.url));
  return {
    url,
    reason: null,
    // Seconds until the signed URL lapses; the caller can cache against it.
    expiresInSec: info.expi ?? null,
    size: info.size ?? null,
    type: info.type ?? null,
  };
}

module.exports = { createQrCode, pollQrCode, shapeCredential, refreshCredential, getAccountInfo, resolveUrl, corsFriendlyUrl, QR_STATUS };
