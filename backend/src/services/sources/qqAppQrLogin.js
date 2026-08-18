/**
 * QQ Music app QR login — scan with QQ Music itself, not with QQ or WeChat.
 *
 * This replaces an earlier attempt that scanned with QQ. That one cannot work
 * from a server at all: it ends at QQ Connect's OAuth authorize step, which
 * signs its request with g_tk = hash33(p_skey), and p_skey is only ever handed
 * to JavaScript running on graph.qq.com. A live scan confirmed it — check_sig
 * accepted the login and returned pt_oauth_token, but no p_skey, and authorize
 * then bounced to the login page. Reproducing that needs a browser, not more
 * request tweaking.
 *
 * This flow never touches ptlogin2 or graph.qq.com. Two calls to QQ Music's own
 * API, both plain JSON:
 *
 *   music.login.LoginServer / CreateQRCode      -> QR image + qrcodeID
 *   music.login.LoginServer / GetQRCodeStatus   -> poll until scanned
 *   music.login.LoginServer / Login             -> exchange for a credential
 *
 * The reference client watches for the scan over MQTT, which is what made this
 * look expensive to implement. It is not necessary: GetQRCodeStatus answers the
 * same question over ordinary HTTP, verified against the live endpoint.
 */
const https = require('https');
const { shapeCredential } = require('./qqLogin');

const HOST = 'u.y.qq.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

/**
 * Client identity. ct must be 11 (the Android QQ Music client).
 *
 * Not cosmetic: GetQRCodeStatus refuses ct 23 (web) and ct 24 outright with
 * 104610 "not in cts-white-list". 11, 6, 1 and 2 were all accepted when tested;
 * 11 is chosen because it matches the app the user is asked to scan with.
 */
const CLIENT = { ct: 11, cv: 13020508, v: 13020508, tmeAppID: 'qqmusic' };

/**
 * Poll outcomes, from the reference client's own event names.
 *
 * A third set of constants, sharing nothing with WeChat's numeric codes or QQ's
 * — these are strings from a different API entirely, and mixing the three would
 * silently misread every state.
 */
const APP_STATUS = {
  new: 'waiting',
  scaned: 'waiting',
  scanned: 'scanned',
  confirmed: 'done',
  cookies: 'done',
  canceled: 'refused',
  timeout: 'expired',
  expired: 'expired',
  loginFailed: 'refused',
};

function fail(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** One musicu.fcg call. Everything here is POST JSON; no cookies involved. */
function call(method, param, comm = {}) {
  const body = Buffer.from(JSON.stringify({
    comm: { ...CLIENT, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', ...comm },
    req_1: { module: 'music.login.LoginServer', method, param },
  }), 'utf8');

  return new Promise((resolve, reject) => {
    // Destroying a request makes it emit ECONNRESET a moment later; without
    // this guard that lands after the promise has settled and surfaces as an
    // unhandled rejection.
    let settled = false;
    const done = (fn) => (v) => { if (!settled) { settled = true; fn(v); } };
    const ok = done(resolve);
    const bad = done(reject);

    const req = https.request({
      hostname: HOST,
      path: '/cgi-bin/musicu.fcg',
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://y.qq.com/',
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        // These responses are a few kilobytes; a QR is ~600 bytes of base64.
        if (size > 4 * 1024 * 1024) {
          req.destroy();
          bad(fail('QQ 音乐响应过大', 'QR_BAD_RESPONSE'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          bad(fail('QQ 音乐响应无法解析', 'QR_BAD_RESPONSE'));
          return;
        }
        ok(json?.req_1 || {});
      });
      // A socket dying mid-body settles nothing without this.
      res.on('error', bad);
    });
    req.on('error', bad);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      bad(fail('QQ 音乐请求超时', 'QR_TIMEOUT'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Step 1 — the QR to display.
 *
 * The image arrives as a complete data URI, so it is passed through untouched
 * rather than decoded and re-encoded.
 */
async function createQrCode() {
  const res = await call('CreateQRCode', { tmeAppID: 'qqmusic' });
  const data = res.data || {};

  if (res.code !== 0 || !data.qrcode || !data.qrcodeID) {
    throw fail('QQ 音乐扫码暂时不可用', 'QR_UNAVAILABLE', { platformCode: res.code });
  }

  return {
    uuid: String(data.qrcodeID),
    image: String(data.qrcode),
    // 900 seconds when measured. Surfaced so the page can refresh in time.
    expiresIn: data.expiresIn ?? null,
  };
}

/**
 * Step 2 — has it been scanned?
 *
 * Answers immediately rather than long-polling, so the caller paces its own
 * loop. `status` is a string here, unlike the other two providers' numeric
 * codes.
 */
async function pollQrCode(qrcodeID) {
  const res = await call('GetQRCodeStatus', { qrcodeID, tmeAppID: 'qqmusic' });
  const info = (res.data || {}).info || {};

  if (res.code !== 0) {
    // 104610 means this client type is not allowed to scan — a wiring fault on
    // our side rather than anything the user did.
    throw fail(info.notSupportTxt || '扫码状态查询失败', 'QR_BAD_RESPONSE', { platformCode: res.code });
  }

  const status = APP_STATUS[info.status] || 'waiting';
  if (status !== 'done') return { status };

  /**
   * The scanning account, and the token that proves the scan.
   *
   * musicId is a string here — which is the point. The numeric musicid loses
   * its last digits past 2^53, and an account named by a rounded id is
   * rejected on every later call.
   */
  const scanUser = info.scanUser || {};
  const musicId = String(scanUser.musicId || '');
  const token = String(info.token || '');
  if (!musicId || !token) {
    throw fail('扫码成功但未能取得登录参数', 'QR_BAD_RESPONSE');
  }

  return { status: 'done', musicId, token, qrcodeID };
}

/**
 * Step 3 — trade the scan for a credential.
 *
 * tmeLoginType 6 identifies this as an app-QR login, distinct from WeChat (1)
 * and QQ (2). The parameter set is not interchangeable with theirs.
 */
async function exchangeCode({ musicId, token, qrcodeID }) {
  const res = await call('Login', {
    musicid: Number(musicId),
    // Sent alongside the number so the platform has an exact copy even when
    // the number itself is rounded in transit.
    str_musicid: musicId,
    qrCodeID: qrcodeID,
    token,
  }, { tmeLoginType: 6 });

  const data = res.data || {};
  if (res.code !== 0 || !data.musickey) {
    throw fail(data.errMsg || 'QQ 音乐登录失败，请重新扫码', 'QR_LOGIN_FAILED', {
      platformCode: res.code,
    });
  }
  // Normalised by the same function the other two flows use, so the cookie
  // shape, the expiry handling and the uin precision fix are shared rather
  // than reimplemented here.
  return shapeCredential(data);
}

module.exports = { createQrCode, pollQrCode, exchangeCode, APP_STATUS };
