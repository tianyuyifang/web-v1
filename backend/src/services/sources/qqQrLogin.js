/**
 * QQ QR login for QQ Music — the second way in, alongside WeChat.
 *
 * Worth having because a QQ Music account is bound to one or the other. Someone
 * whose account was created with QQ cannot sign in by scanning with WeChat: the
 * scan succeeds and returns a credential for a *different*, empty account. So
 * this is not a nicer front door on the same house, it is the only door for
 * those users.
 *
 * Four steps, against three different hosts, where WeChat needs two:
 *
 *   1. ptqrshow      -> the QR image, and `qrsig` in a Set-Cookie header
 *   2. ptqrlogin     -> poll; answers with JavaScript, not JSON
 *   3. check_sig     -> exchanges the scan for `p_skey`, again via Set-Cookie
 *   4. authorize     -> answers 302, with the OAuth code in the Location header
 *
 * Three of those four carry their payload somewhere other than the body, which
 * is the main reason this is fiddly: redirects must NOT be followed (the code
 * only exists on the hop itself) and cookies must be carried forward by hand.
 *
 * Shapes are taken from a working client (luren-dc/QQMusicApi, modules/login.py)
 * rather than reconstructed. The appid/daid/pt_3rd_aid triple is QQ Music's own
 * and is what makes the resulting credential a music credential; changing any
 * of them yields a token that the vkey service will not accept.
 */
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://xui.ptlogin2.qq.com/';

/** QQ Music's own OAuth identity. All three must agree across every step. */
const APPID = '716027609';
const DAID = '383';
const PT_3RD_AID = '100497308';

/**
 * Poll outcomes, from the reference client's QRCodeLoginEvents.
 *
 * These are QQ's own codes and share nothing with WeChat's 4xx-looking set, so
 * the two maps are kept apart — reading one with the other's table silently
 * mis-reports every state rather than failing.
 *
 * Note 0 means *success* here, where a 0 would ordinarily read as "nothing has
 * happened yet". Guessing an ordinal sequence for these would have made a
 * completed login look like a still-waiting one, forever.
 */
const QQ_STATUS = {
  0: 'done',
  66: 'waiting',
  67: 'scanned',
  65: 'expired',
  68: 'refused',
};

/**
 * Hash33, QQ's own token derivation.
 *
 * Used twice with different seeds: 0 for the poll token, 5381 for g_tk. The
 * mask keeps it inside 31 bits, which also keeps it positive — JavaScript's
 * `<<` is a signed 32-bit operation, so without the mask this could go
 * negative where the reference implementation does not.
 */
function hash33(str, seed = 0) {
  let h = seed;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) & 2147483647;
  }
  return h;
}

/** Collect Set-Cookie into a plain map; these steps pass state via cookies. */
function readCookies(res) {
  const jar = {};
  for (const line of res.headers['set-cookie'] || []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function serialiseCookies(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * A request that never follows redirects and always surfaces headers.
 *
 * Both matter here: step 4's entire payload is a Location header on a 302, and
 * following it would discard the code and land on a page we cannot read.
 */
function request(url, { headers = {}, method = 'GET', form = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = form ? Buffer.from(new URLSearchParams(form).toString(), 'utf8') : null;

    let settled = false;
    const done = (fn) => (v) => { if (!settled) { settled = true; fn(v); } };
    const ok = done(resolve);
    const fail = done(reject);

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        ...(payload
          ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length }
          : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) {
          req.destroy();
          fail(new Error('QQ login response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => ok({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
      // A socket dying mid-body settles nothing without this, and the caller
      // waits out its full timeout for a response that will never arrive.
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

function fail(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Step 1 — fetch the QR image.
 *
 * `qrsig` arrives as a cookie and is the only handle on this attempt; it is
 * returned to the caller as the identifier so polling can send it back.
 */
async function createQrCode() {
  const params = new URLSearchParams({
    appid: APPID,
    e: '2',
    l: 'M',
    s: '3',
    d: '72',
    v: '4',
    // The reference client sends a random float purely as a cache-buster.
    t: String(Math.random()),
    daid: DAID,
    pt_3rd_aid: PT_3RD_AID,
  });

  const res = await request(`https://ssl.ptlogin2.qq.com/ptqrshow?${params}`);
  if (res.status !== 200 || !res.buf.length) {
    throw fail('QQ 扫码暂时不可用', 'QR_UNAVAILABLE');
  }

  const qrsig = readCookies(res).qrsig;
  if (!qrsig) {
    // No qrsig means the flow cannot proceed at all, and the shape has
    // presumably changed — callers fall back to WeChat or manual entry.
    throw fail('QQ 登录页面结构已变化，请改用微信扫码或手动输入 Cookie', 'QR_SHAPE_CHANGED');
  }

  return {
    uuid: qrsig,
    image: `data:image/png;base64,${res.buf.toString('base64')}`,
  };
}

/**
 * Step 2 — has it been scanned?
 *
 * Unlike WeChat this does not long-poll; it answers immediately, so the caller
 * paces its own loop. The response is a JavaScript call, `ptuiCB('0','0',...)`,
 * whose first argument is the status and whose third carries uin and ptsigx
 * once the scan is confirmed.
 */
async function pollQrCode(qrsig) {
  const params = new URLSearchParams({
    u1: 'https://graph.qq.com/oauth2.0/login_jump',
    ptqrtoken: String(hash33(qrsig)),
    ptredirect: '0',
    h: '1',
    t: '1',
    g: '1',
    from_ui: '1',
    ptlang: '2052',
    action: `0-0-${Date.now()}`,
    js_ver: '20102616',
    js_type: '1',
    pt_uistyle: '40',
    aid: APPID,
    daid: DAID,
    pt_3rd_aid: PT_3RD_AID,
    has_onekey: '1',
  });

  const res = await request(`https://ssl.ptlogin2.qq.com/ptqrlogin?${params}`, {
    headers: { Cookie: `qrsig=${qrsig}` },
  });

  const text = res.buf.toString('utf8');
  const call = text.match(/ptuiCB\((.*?)\)/);
  if (!call) throw fail('无法解析扫码状态', 'QR_BAD_RESPONSE');

  // Single-quoted arguments, which may themselves contain escaped quotes.
  const args = [...call[1].matchAll(/'((?:\\.|[^'])*)'/g)].map((m) => m[1]);
  const status = QQ_STATUS[Number(args[0])];
  if (!status) throw fail('无法解析扫码状态', 'QR_BAD_RESPONSE');
  if (status !== 'done') return { status };

  // On success the third argument is a URL carrying the two values step 3
  // needs. Both must be present; half of them is not a usable state.
  const redirect = args[2] || '';
  const sigx = (redirect.match(/[?&]ptsigx=(.+?)&s_url/) || [])[1];
  const uin = (redirect.match(/[?&]uin=(.+?)&service/) || [])[1];
  if (!sigx || !uin) throw fail('扫码成功但未能取得登录参数', 'QR_BAD_RESPONSE');

  return { status: 'done', uin, sigx };
}

/**
 * Steps 3 and 4 — turn a confirmed scan into an OAuth code.
 *
 * Neither hop may follow its redirect: step 3's p_skey is set on a response
 * that immediately redirects away, and step 4's code exists only in a Location
 * header. Following either loses the value entirely.
 */
async function exchangeCode({ uin, sigx }) {
  const sigParams = new URLSearchParams({
    uin,
    pttype: '1',
    service: 'ptqrlogin',
    nodirect: '0',
    ptsigx: sigx,
    s_url: 'https://graph.qq.com/oauth2.0/login_jump',
    ptlang: '2052',
    ptredirect: '100',
    aid: APPID,
    daid: DAID,
    j_later: '0',
    low_login_hour: '0',
    regmaster: '0',
    pt_login_type: '3',
    pt_aid: '0',
    pt_aaid: '16',
    pt_light: '0',
    pt_3rd_aid: PT_3RD_AID,
  });

  const sigRes = await request(`https://ssl.ptlogin2.graph.qq.com/check_sig?${sigParams}`);
  const jar = readCookies(sigRes);
  if (!jar.p_skey) throw fail('QQ 授权失败，请重新扫码', 'QR_LOGIN_FAILED');

  const authRes = await request('https://graph.qq.com/oauth2.0/authorize', {
    method: 'POST',
    headers: { Cookie: serialiseCookies(jar) },
    form: {
      response_type: 'code',
      client_id: PT_3RD_AID,
      redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
      scope: 'get_user_info,get_app_friends',
      state: 'state',
      switch: '',
      from_ptlogin: '1',
      src: '1',
      update_auth: '1',
      openapi: '1010_1030',
      g_tk: String(hash33(jar.p_skey, 5381)),
      auth_time: String(Date.now()),
      // Any uuid; the endpoint only checks that one is present.
      ui: require('crypto').randomUUID(),
    },
  });

  const location = authRes.headers.location || '';
  const code = (location.match(/[?&]code=([^&]+)/) || [])[1];
  if (!code) throw fail('QQ 授权失败，请重新扫码', 'QR_LOGIN_FAILED');

  return code;
}

module.exports = { createQrCode, pollQrCode, exchangeCode, hash33 };
