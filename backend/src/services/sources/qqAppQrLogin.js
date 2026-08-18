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
const mqttWatcher = require('./qqMqttWatcher');

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

  // Connect before returning, so a fast scan cannot arrive before we are
  // listening — establishing the connection takes a few seconds.
  await watchQrCode(String(data.qrcodeID));

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
/**
 * Scans in progress, keyed by qrcodeID.
 *
 * Each entry owns one MQTT connection and the last event it saw. The browser
 * still polls this server every couple of seconds; that poll now reads a value
 * pushed to us rather than asking QQ Music, which is the part that could not
 * work — the status endpoint belongs to the scanning app, not to us.
 *
 * Entries are dropped as soon as the login settles, and swept on age so an
 * abandoned scan cannot hold a socket open. A QR lives fifteen minutes.
 */
const watches = new Map();
const WATCH_TTL_MS = 16 * 60 * 1000;

function closeWatch(qrcodeID) {
  const w = watches.get(qrcodeID);
  if (!w) return;
  watches.delete(qrcodeID);
  try { w.client?.end(true); } catch { /* already gone */ }
}

function sweepWatches() {
  const cutoff = Date.now() - WATCH_TTL_MS;
  for (const [id, w] of watches) {
    if (w.startedAt < cutoff) closeWatch(id);
  }
}

/**
 * Begin listening for this code to be scanned.
 *
 * Called once, right after the QR is created, so the connection is already up
 * before the user can possibly scan. Doing it lazily on first poll would risk
 * missing a fast scan, since connecting takes a few seconds.
 */
async function watchQrCode(qrcodeID) {
  sweepWatches();
  if (watches.has(qrcodeID)) return;

  const entry = { client: null, event: { status: 'waiting' }, startedAt: Date.now() };
  watches.set(qrcodeID, entry);

  try {
    const client = await mqttWatcher.connectAndSubscribe(qrcodeID);
    // The attempt may have been abandoned while we were connecting.
    if (!watches.has(qrcodeID)) { client.end(true); return; }
    entry.client = client;

    client.on('message', (_topic, payload, packet) => {
      const type = packet?.properties?.userProperties?.type;
      let parsed = null;
      try { parsed = JSON.parse(payload.toString('utf8')); } catch { /* not JSON */ }
      const event = mqttWatcher.readEvent(
        Array.isArray(type) ? type[0] : type,
        parsed,
      );
      if (event) entry.event = event;
    });
  } catch (err) {
    // Recorded rather than thrown: the caller already has a QR on screen, and
    // the next poll reports this cleanly instead of the request failing.
    entry.event = { status: 'error', message: err.message };
  }
}

/**
 * What has happened to this code so far.
 *
 * Reads the last event MQTT delivered. No outbound request is made here, so
 * the browser's polling costs nothing at the platform and cannot be mistaken
 * for hammering a login endpoint.
 */
async function pollQrCode(qrcodeID) {
  const entry = watches.get(qrcodeID);
  if (!entry) {
    // Nothing listening: the code was never started here, or it expired and
    // was swept. Either way it cannot complete.
    throw fail('二维码已失效，请重新生成', 'QR_SESSION_LOST');
  }

  const event = entry.event;
  if (event.status === 'error') {
    closeWatch(qrcodeID);
    throw fail(event.message || '扫码通知服务不可用', 'QR_MQTT_FAILED');
  }
  if (event.status === 'expired' || event.status === 'refused') {
    closeWatch(qrcodeID);
    return { status: event.status };
  }
  if (event.status !== 'done') return { status: event.status };

  return { status: 'done', musicId: event.musicId, token: event.token, qrcodeID };
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
    /**
     * Named outcomes, from the reference client's documented codes.
     *
     * Each says something the user can act on, and none of them mean "try
     * again" — repeating a scan against a device limit or a restricted account
     * achieves nothing, and that kind of retry is what draws attention to an
     * account.
     */
    const KNOWN = {
      20279: '这个账号登录的设备数已达上限，请先在 QQ 音乐 APP 里退出其他设备',
      20277: '账号状态异常，暂时无法登录',
      20278: '账号状态异常，暂时无法登录',
      20450: '账号已被封禁',
      104604: '操作过于频繁，请稍后再试',
    };
    closeWatch(qrcodeID);
    throw fail(KNOWN[res.code] || data.errMsg || 'QQ 音乐登录失败，请重新扫码', 'QR_LOGIN_FAILED', {
      platformCode: res.code,
      // Retrying these cannot help, so the page should not invite it.
      retryable: !KNOWN[res.code],
    });
  }

  // The scan is spent; the socket has nothing left to deliver.
  closeWatch(qrcodeID);
  // Normalised by the same function the other two flows use, so the cookie
  // shape, the expiry handling and the uin precision fix are shared rather
  // than reimplemented here.
  // 6 is stated, not inferred: this flow's key prefix is indistinguishable
  // from a QQ login's, and renewal depends on getting this right.
  return shapeCredential(data, 6);
}

module.exports = { createQrCode, watchQrCode, pollQrCode, exchangeCode, closeWatch };
