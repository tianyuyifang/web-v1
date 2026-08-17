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
   * On success the third argument is a URL for the browser to visit next.
   *
   * Both forms of it are kept. The reference client ignores this URL and
   * rebuilds an equivalent one with ptredirect=100, where the URL handed back
   * carries ptredirect=0 — the value ptqrlogin was called with. Only the
   * rebuilt form is known to yield p_skey, so the exchange tries that first and
   * falls back to the server's own URL. Which one works is recorded, because a
   * live scan is the only way to find out and the answer should not have to be
   * rediscovered.
   */
  const redirect = args[2] || '';
  if (!/^https?:\/\//.test(redirect)) {
    throw fail('扫码成功但未能取得登录地址', 'QR_BAD_RESPONSE', { detail: redirect.slice(0, 120) });
  }

  // Parsed off the URL rather than assumed: only the server knows these two.
  const returned = new URL(redirect).searchParams;
  const uin = returned.get('uin');
  const sigx = returned.get('ptsigx');
  if (!uin || !sigx) {
    throw fail('扫码成功但未能取得登录参数', 'QR_BAD_RESPONSE', { detail: redirect.slice(0, 160) });
  }

  // qrsig travels on so the exchange can pick this login's jar back up. The
  // URL itself is no longer requested — only uin and ptsigx are taken from it —
  // but it is carried for the log, since its ptredirect value is the one piece
  // of this flow that is still not understood.
  return { status: 'done', redirect, uin, sigx, qrsig };
}

/**
 * Steps 3 and 4 — turn a confirmed scan into an OAuth code.
 *
 * Redirects are followed by hand rather than by the HTTP client, because the
 * code is carried in a Location header and would be consumed by an automatic
 * redirect. Cookies accumulate along the way.
 */

/**
 * The check_sig URL, rebuilt rather than taken as given.
 *
 * The URL the poll hands back carries ptredirect=0, inherited from the poll
 * call itself; this uses 100, matching the reference client. Measured against
 * a rejected sigx the two behave identically, so this is kept for consistency
 * with the client known to work, not because the difference is understood.
 */
function rebuiltSigUrl(uin, sigx) {
  return 'https://ssl.ptlogin2.graph.qq.com/check_sig?' + new URLSearchParams({
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
}

/** One hop, recorded. Cookie names only — never their values. */
function note(trail, label, url, res, fresh) {
  const location = res.headers.location || '';
  const u = new URL(url);
  trail.push(`${label} ${u.hostname}${u.pathname} ${res.status}`
    + ` cookies[${fresh.join(',') || '-'}]`
    + (location ? ` ->${new URL(location, url).hostname}` : '')
    + (/[?&]code=/.test(location) ? ' HAS_CODE' : ''));
  return location;
}

/**
 * Walk the redirect chain after a confirmed scan, collecting cookies.
 *
 * It no longer stops when p_skey fails to appear. A live scan showed check_sig
 * answering 302 with pt_oauth_token and pt_login_type but no p_skey, and the
 * old code treated that as a refusal — even though redirecting to s_url rather
 * than www.qq.com is what acceptance looks like. So the chain is walked to its
 * end and the caller decides, rather than a missing cookie deciding for it.
 */
async function walkChain(startUrl, startJar, trail, label) {
  let url = startUrl;
  let jar = startJar;

  for (let hop = 0; hop < 6; hop += 1) {
    const res = await request(url, { headers: { Cookie: serialiseCookies(jar) } });
    const before = new Set(Object.keys(jar));
    jar = mergeCookies(jar, res);
    const location = note(trail, `${label}#${hop + 1}`, url, res,
      Object.keys(jar).filter((k) => !before.has(k)));

    // A code anywhere in the chain ends it: that is the thing being sought.
    const code = (location.match(/[?&]code=([^&]+)/) || [])[1];
    if (code) return { jar, code };
    if (!location) return { jar };
    url = new URL(location, url).toString();
  }
  return { jar };
}

async function exchangeCode({ uin, sigx, qrsig }) {
  const session = sessions.get(qrsig);
  if (!session) throw fail('登录会话已失效，请重新扫码', 'QR_SESSION_LOST');

  const trail = [];

  /**
   * One attempt only, deliberately.
   *
   * ptsigx is single-use: a second check_sig with the same one returns no
   * cookies at all, which was measured — repeating an identical request with a
   * *rejected* sigx returns its cookies every time, so repetition alone does
   * not explain the empty result. An earlier version tried a second URL form as
   * a fallback and so spent the only chance the scan gets, then reported the
   * failure of the retry rather than the success of the first attempt.
   */
  const { jar, code } = await walkChain(rebuiltSigUrl(uin, sigx), session.jar, trail, 'check_sig');
  if (code) {
    sessions.delete(qrsig);
    console.info('[qq-qr] ok (code from redirect chain) | %s', trail.join(' | '));
    return code;
  }

  /**
   * Ask the authorization endpoint outright.
   *
   * This is the step the flow never reached before: it gave up when p_skey was
   * absent, so authorize was never called at all. In a browser this request is
   * made by the page after login_jump signals success, carrying whatever login
   * cookies were just set. For an account that has already authorized this
   * application, the documented behaviour is a redirect straight back to
   * redirect_uri with the code.
   *
   * GET, per QQ Connect's own documentation, and without g_tk — that parameter
   * is derived from p_skey, which this flow does not receive. If the endpoint
   * turns out to require it, the trail will say so by redirecting to the login
   * page instead of to redirect_uri.
   */
  const authUrl = 'https://graph.qq.com/oauth2.0/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: PT_3RD_AID,
    redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
    scope: 'get_user_info,get_app_friends',
    state: 'state',
  });

  const authWalk = await walkChain(authUrl, jar, trail, 'authorize');
  sessions.delete(qrsig);

  if (authWalk.code) {
    console.info('[qq-qr] ok (code from authorize) | %s', trail.join(' | '));
    return authWalk.code;
  }

  // Everything known about this attempt, so the next one does not start from
  // scratch. Each scan is one shot, so a failure that explains nothing is
  // expensive.
  throw fail('QQ 授权失败，请重新扫码', 'QR_LOGIN_FAILED', { trail: trail.join(' | ') });
}

module.exports = { createQrCode, pollQrCode, exchangeCode, hash33 };
