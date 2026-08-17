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

/**
 * The login page every later step is judged against.
 *
 * Fetching it is not optional and not a formality: it mints the session the
 * whole flow runs inside — pt_login_sig, pt_guid_sig, ptui_identifier and
 * others. Starting at ptqrshow instead produces a QR that scans fine and then
 * fails at check_sig, because there is no session for the scan to be validated
 * against. That is precisely the "QQ 授权失败" this flow hit.
 *
 * It doubles as the Referer for every subsequent request. The bare host is not
 * enough; these endpoints check the full URL, which is how they know which
 * application is asking.
 */
const XLOGIN_URL = 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?' + new URLSearchParams({
  proxy_url: 'https://y.qq.com/portal/proxy.html',
  daid: '383',
  hide_title_bar: '1',
  low_login: '0',
  qlogin_auto_login: '1',
  no_verifyimg: '1',
  link_target: 'blank',
  appid: '716027609',
  style: '22',
  target: 'self',
  s_url: 'https://graph.qq.com/oauth2.0/login_jump',
  pt_3rd_aid: '100497308',
  pt_no_auth: '1',
});
const REFERER = XLOGIN_URL;

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

/**
 * Merge this response's Set-Cookie headers into a jar, and return it.
 *
 * The whole flow is one login session, not four independent calls: ptqrlogin
 * sets cookies that check_sig needs, and check_sig sets p_skey that authorize
 * needs. The reference client gets this for free because it runs every request
 * through one persistent session; here the jar has to be carried by hand.
 *
 * Sending each step only the cookies it was explicitly given is exactly the
 * bug that made a scanned code fail at "QQ 授权失败" — the scan succeeded, but
 * the next hop arrived with no session behind it.
 *
 * Deletions are honoured (`EXPIRED`, empty values) so a cookie the server
 * clears does not linger and get replayed.
 */
function mergeCookies(jar, res) {
  for (const line of res.headers['set-cookie'] || []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || value === 'EXPIRED') delete jar[name];
    else jar[name] = value;
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
 * Cookie jars for logins currently in progress, keyed by qrsig.
 *
 * Held server-side rather than handed to the browser: these are live login
 * cookies for the user's QQ account, and the same rule applies to them as to a
 * stored credential — anything that reaches the page can be read out of it.
 * The browser only ever sees the qrsig, which is useless without the jar.
 *
 * Entries are dropped once the login finishes, and swept on age so an
 * abandoned scan cannot pin memory. A QR is only valid for a couple of
 * minutes, so five is well past the point where an entry could still be used.
 */
const sessions = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;

function sweepSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, entry] of sessions) {
    if (entry.at < cutoff) sessions.delete(key);
  }
}

/**
 * Step 1 — fetch the QR image.
 *
 * `qrsig` arrives as a cookie and is the only handle on this attempt; it is
 * returned to the caller as the identifier so polling can send it back.
 */
async function createQrCode() {
  // Step 0 — open the login page and keep everything it sets. Without this the
  // QR is issued against no session and the scan cannot be verified later.
  const pageRes = await request(XLOGIN_URL);
  const jar = mergeCookies({}, pageRes);
  if (!jar.pt_login_sig) {
    throw fail('QQ 登录页面结构已变化，请改用微信扫码或手动输入 Cookie', 'QR_SHAPE_CHANGED');
  }

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

  const res = await request(`https://ssl.ptlogin2.qq.com/ptqrshow?${params}`, {
    headers: { Cookie: serialiseCookies(jar) },
  });
  if (res.status !== 200 || !res.buf.length) {
    throw fail('QQ 扫码暂时不可用', 'QR_UNAVAILABLE');
  }

  mergeCookies(jar, res);
  const qrsig = jar.qrsig;
  if (!qrsig) {
    // No qrsig means the flow cannot proceed at all, and the shape has
    // presumably changed — callers fall back to WeChat or manual entry.
    throw fail('QQ 登录页面结构已变化，请改用微信扫码或手动输入 Cookie', 'QR_SHAPE_CHANGED');
  }

  // The jar, not just the qrsig, is what the later steps need. Kept here so
  // the browser never has to hold login cookies.
  sweepSessions();
  sessions.set(qrsig, { jar, at: Date.now() });

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

  // Resume this login's jar. A qrsig with no session behind it means the
  // attempt expired or was never started here.
  const session = sessions.get(qrsig);
  if (!session) throw fail('二维码已失效，请重新生成', 'QR_SESSION_LOST');

  const res = await request(`https://ssl.ptlogin2.qq.com/ptqrlogin?${params}`, {
    headers: { Cookie: serialiseCookies(session.jar) },
  });

  // ptqrlogin sets cookies that check_sig then requires; without carrying them
  // forward the next step arrives with no login session and is refused.
  mergeCookies(session.jar, res);
  session.at = Date.now();

  const text = res.buf.toString('utf8');
  const call = text.match(/ptuiCB\((.*?)\)/);
  if (!call) throw fail('无法解析扫码状态', 'QR_BAD_RESPONSE');

  // Single-quoted arguments, which may themselves contain escaped quotes.
  const args = [...call[1].matchAll(/'((?:\\.|[^'])*)'/g)].map((m) => m[1]);
  const status = QQ_STATUS[Number(args[0])];
  if (!status) throw fail('无法解析扫码状态', 'QR_BAD_RESPONSE');
  if (status !== 'done') return { status };

  /**
   * On success the third argument is the URL to visit next, already carrying
   * every parameter the server wants.
   *
   * It is used verbatim rather than picked apart and rebuilt. Reconstructing it
   * means guessing at parameter names and ordering that only the server knows,
   * and any drift there fails as a refusal rather than as a parse error — which
   * is indistinguishable from a rejected login and was the likely reason this
   * flow kept answering "QQ 授权失败".
   */
  const redirect = args[2] || '';
  if (!/^https?:\/\//.test(redirect)) {
    throw fail('扫码成功但未能取得登录地址', 'QR_BAD_RESPONSE', { detail: redirect.slice(0, 120) });
  }

  // qrsig travels on so the exchange can pick this login's jar back up.
  return { status: 'done', redirect, qrsig };
}

/**
 * Steps 3 and 4 — turn a confirmed scan into an OAuth code.
 *
 * Neither hop may follow its redirect: step 3's p_skey is set on a response
 * that immediately redirects away, and step 4's code exists only in a Location
 * header. Following either loses the value entirely.
 */
async function exchangeCode({ redirect, qrsig }) {
  const session = sessions.get(qrsig);
  if (!session) throw fail('登录会话已失效，请重新扫码', 'QR_SESSION_LOST');

  /**
   * Follow the chain the server described, rather than one URL we assumed.
   *
   * check_sig answers 302 and the login cookies can be set on any hop along the
   * way, so each redirect is walked in turn, accumulating cookies, until p_skey
   * appears. The cap is a safety net against a redirect loop, not an expected
   * depth — the chain is normally one or two hops.
   */
  let url = redirect;
  let jar = session.jar;
  let hops = 0;
  const trail = [];

  while (hops < 6) {
    hops += 1;
    const res = await request(url, { headers: { Cookie: serialiseCookies(jar) } });
    jar = mergeCookies(jar, res);
    trail.push(`${new URL(url).hostname}${new URL(url).pathname}->${res.status}`);
    if (jar.p_skey) break;

    const next = res.headers.location;
    // A response that neither sets p_skey nor points anywhere else is the end
    // of the line, and the login was refused.
    if (!next) break;
    url = new URL(next, url).toString();
  }

  if (!jar.p_skey) {
    // The trail names which hops were walked and what they answered, so a
    // failure here can be diagnosed from the log instead of re-derived.
    throw fail('QQ 授权失败，请重新扫码', 'QR_LOGIN_FAILED', { trail: trail.join(' | ') });
  }

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
  // The jar is spent either way: on success the code supersedes it, on failure
  // it cannot be retried. Dropping it here keeps live QQ session cookies in
  // memory for no longer than the login actually needs them.
  sessions.delete(qrsig);
  if (!code) throw fail('QQ 授权失败，请重新扫码', 'QR_LOGIN_FAILED');

  return code;
}

module.exports = { createQrCode, pollQrCode, exchangeCode, hash33 };
