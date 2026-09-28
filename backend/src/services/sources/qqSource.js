/**
 * QQ Music adapter: search, playlist, lyric, and playback-URL resolution.
 *
 * Only the URL is resolved here. The audio itself is fetched by the listener's
 * browser straight from the CDN, which is what keeps this feature off our
 * bandwidth bill — measured at ~6 KB of traffic per song against 4 MB for the
 * audio. The CDN sends `access-control-allow-origin: *` and honours range
 * requests, so the browser can seek and decode normally.
 *
 * Request shapes are copied from a client that currently works
 * (L-1124/QQMusicApi, `qqmusic_api/modules/song.py`) rather than
 * reconstructed. That matters more than it sounds: the older, widely-copied
 * `vkey.GetVkeyServer` / `CgiGetVkey` endpoint has been retired and now
 * answers `104009` for everyone, from any address, logged in or not. It is
 * easy to mistake that for a block on your own IP — a whole afternoon went
 * into diagnosing "rate limiting" that was really a dead endpoint.
 *
 * Resolving one song takes two calls, which can run in parallel:
 *   music.audioCdnDispatch.cdnDispatch  -> which CDN hosts to use
 *   music.vkey.GetVkey / UrlGetVkey     -> the signed path for this track
 * Both must carry the SAME guid, and the finished URL needs `&fromtag=3`
 * appended; get either wrong and the CDN answers 403. When the pieces do not
 * line up, the dispatch response carries a `testfile2g` sample URL that is
 * known to work — diffing its query string against ours is what found the
 * missing `fromtag`.
 *
 * Every request goes through the circuit breaker: all users' lookups leave
 * from one server address, so a retry loop would not degrade one person's
 * playback but take the feature down for everyone. See musicSourceBreaker.
 */
const https = require('https');
const crypto = require('crypto');
const breaker = require('../musicSourceBreaker');

const PLATFORM = 'qq';
const HOST = 'u.y.qq.com';
const LYRIC_HOST = 'c.y.qq.com';
const TIMEOUT_MS = 12000;

/**
 * Client identity sent with every call. The version numbers are what a current
 * desktop client reports; the endpoint rejects requests that look too old.
 */
const CLIENT = { ct: 11, cv: 13020508, v: 13020508, tmeAppID: 'qqmusic' };

/**
 * Smallest gap between two calls to this platform.
 *
 * QQ publishes no rate-limit documentation and sends none of the standard
 * signals — no Retry-After, no RateLimit-* headers (checked). With nothing to
 * read, the guidance for that case is to keep concurrency low and spread
 * requests out, so bursts get flattened into a queue instead of arriving all
 * at once. 200 ms is invisible to someone pressing play and still allows five
 * songs a second, far above what this feature needs.
 */
const MIN_GAP_MS = 200;
let lastCallAt = 0;

/**
 * CDN hosts, cached.
 *
 * The dispatch response is about which edge servers to use, not about any
 * particular song, so asking once per song doubles our request count for no
 * benefit. Caching it halves outbound traffic — and the cheapest request is
 * the one never sent, which beats any amount of careful throttling.
 *
 * The guid is cached alongside, because the CDN checks that the guid in the
 * URL matches the one the vkey was signed for.
 */
let cdnCache = null; // { hosts: string[], guid: string, at: number }
let cdnInflight = null; // promise, shared by everyone waiting on a cold lookup
const CDN_TTL_MS = 10 * 60 * 1000;
/** A 3,000-song playlist is ~2 MB; 16 MB is far above anything legitimate. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Shared keep-alive agent.
 *
 * Node's default agent opens a fresh TCP+TLS connection per request and leaves
 * it in TIME_WAIT afterwards; a long import makes thousands of them and can
 * exhaust ephemeral ports. Reusing sockets also drops the handshake from each
 * call, which matters here because the platform is ~200 ms away.
 *
 * maxSockets is deliberately tiny. The breaker already caps requests in
 * flight, and this is the backstop: even a bug that bypassed the breaker
 * cannot open a wide fan of connections to one platform.
 */
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 4,
  maxFreeSockets: 2,
  // Drop idle sockets rather than holding them open indefinitely; the platform
  // will close them anyway and a half-dead socket surfaces as a hung request.
  timeout: 30000,
});

/** Quality tier -> filename prefix and extension. */
const TIERS = {
  m4a: { prefix: 'C400', ext: '.m4a' },
  mp3_128: { prefix: 'M500', ext: '.mp3' },
  mp3_320: { prefix: 'M800', ext: '.mp3' },
  flac: { prefix: 'F000', ext: '.flac' },
};

/**
 * Wait out the minimum gap, so bursts queue instead of arriving together.
 *
 * The slot is claimed before the wait, not after it. Reading the clock, then
 * sleeping, then writing it back looks equivalent and is not: every concurrent
 * caller reads the same value, computes the same delay, sleeps in parallel and
 * fires together. Measured that way, twenty callers left within 200ms of each
 * other rather than spread over the 3.8 seconds the gap implies -- a delay, not
 * a rate limit.
 *
 * Reserving first makes each caller wait for the slot the previous one took, so
 * the queue is real and the ceiling is the one this file claims: five calls a
 * second to QQ from this machine, however many people are asking.
 */
async function pace() {
  const now = Date.now();
  // max(), so an idle period does not let a caller claim a slot in the past and
  // hand the next one a free pass.
  const slot = Math.max(now, lastCallAt + MIN_GAP_MS);
  lastCallAt = slot;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function request(url, { headers = {}, host, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const startedAt = Date.now();
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request({
      hostname: host || u.hostname,
      path: u.pathname + u.search,
      method: payload ? 'POST' : 'GET',
      agent,
      headers: {
        // The vkey service checks Referer; a bare request is refused.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://y.qq.com/',
        Origin: 'https://y.qq.com',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      // Kept as bytes and decoded once at the end, rather than appended to a
      // string as each chunk arrives.
      //
      // `text += chunk` decodes every chunk on its own, and a chunk boundary
      // lands wherever TCP happens to put it -- which is sometimes in the
      // middle of a character. Each half then decodes to U+FFFD, and the song
      // is stored with a hole in its name: 123木头人 came out as 123���头人,
      // 陪你去流浪 lost its 薛. Twelve catalogue rows were damaged this way
      // before anyone noticed, and nothing in the row could say what the
      // missing character had been.
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        // Guard against an endless body. These endpoints answer in kilobytes;
        // the largest legitimate response is a 3,000-song playlist at ~2 MB.
        // Without a ceiling a misrouted response could grow until the process
        // runs out of memory.
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error(`QQ response exceeded ${MAX_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
        ms: Date.now() - startedAt,
        bytes: size,
      }));
      // A socket that dies mid-body emits here, not on the request. Without
      // this the promise never settles and the caller hangs forever holding
      // its breaker slot.
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`QQ request timed out after ${TIMEOUT_MS}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Seconds to wait, per the server's own Retry-After header.
 *
 * QQ does not currently send it, but it is the most reliable signal there is
 * and gateways in front of an origin do send it under load, so honouring it
 * costs nothing and beats guessing whenever it does appear. Accepts both forms
 * the spec allows: a delay in seconds, or an HTTP date.
 */
function retryAfterMs(headers) {
  const raw = headers && headers['retry-after'];
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

/**
 * One musicu.fcg call, with the breaker wrapped around it.
 *
 * `codeOf` pulls the platform's own status out of the response so the breaker
 * can tell "you are being throttled" apart from "that song needs VIP". Only the
 * former should ever stop traffic; tripping on the latter would disable
 * playback over ordinary missing songs.
 */
async function callCgi({ url, cookie, codeOf, body = null }) {
  // Claims an in-flight slot as well as checking the breaker, so a burst of
  // simultaneous callers cannot all reach the platform before the first
  // failure is recorded.
  breaker.acquire(PLATFORM);

  let res;
  try {
    await pace();
    res = await request(url, {
      body,
      ...(cookie ? { headers: { Cookie: cookie } } : {}),
    });
  } catch (err) {
    // Network-level failures are not rate limiting; leave the breaker alone.
    err.platform = PLATFORM;
    throw err;
  } finally {
    breaker.release(PLATFORM);
  }

  // A transport-level failure must never reach the parser. An outage that
  // happens to answer with a JSON-ish body would otherwise be read as "the
  // platform has no URL for this song", i.e. as a permission answer, and get
  // written into the mapping table as though the track needed VIP.
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`QQ 返回 HTTP ${res.status}`);
    err.code = 'SOURCE_HTTP_ERROR';
    err.httpStatus = res.status;
    err.platform = PLATFORM;
    // If the server said when to come back, that beats any guess we could make.
    const wait = retryAfterMs(res.headers);
    if (wait) err.retryAfterMs = wait;
    // 429/403 are the shapes a proxy or gateway uses to say "slow down", so
    // they count toward the breaker even though they carry no platform code.
    if (res.status === 429 || res.status === 403) {
      err.breakerOpened = breaker.recordFailure(PLATFORM, 104604);
    }
    throw err;
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    const err = new Error('QQ returned a non-JSON response');
    err.code = 'SOURCE_BAD_RESPONSE';
    err.platform = PLATFORM;
    throw err;
  }

  const platformCode = codeOf ? codeOf(json) : json.code;
  if (breaker.isRateLimit(platformCode)) {
    const opened = breaker.recordFailure(PLATFORM, platformCode);
    const err = new Error(opened
      ? 'QQ 音源已暂停请求（触发限流保护）'
      : `QQ 拒绝了请求 (code ${platformCode})`);
    err.code = 'SOURCE_RATE_LIMITED';
    err.platformCode = platformCode;
    err.platform = PLATFORM;
    err.breakerOpened = opened;
    throw err;
  }

  breaker.recordSuccess(PLATFORM);
  return { json, meta: { ms: res.ms, bytes: res.bytes } };
}

function cgiUrl(data, extraParams = {}) {
  const params = new URLSearchParams({
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    ...extraParams,
    data: JSON.stringify(data),
  });
  return `https://${HOST}/cgi-bin/musicu.fcg?${params}`;
}

/** Shape one search/playlist row into the form the mapping layer stores. */
function toTrack(s) {
  return {
    source: 'QQ',
    externalId: s.mid,
    title: s.name || s.title || '',
    artist: (s.singer || []).map((x) => x.name).filter(Boolean).join('/'),
    durationSec: s.interval ?? null,
    album: s.album?.name ?? null,
    // pay_play=1 means the track needs a VIP subscription. Knowing this up
    // front lets review flag "this will not play" without trying it.
    vipOnly: Boolean(s.pay?.pay_play),
  };
}

/**
 * Search by keyword. Requires a cookie — an anonymous search returns code 2001
 * and zero results.
 */
async function search(keyword, { cookie, limit = 20 } = {}) {
  const { json, meta } = await callCgi({
    cookie,
    codeOf: (j) => j?.req_1?.code,
    url: cgiUrl({
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: { num_per_page: limit, page_num: 1, query: String(keyword), search_type: 0 },
      },
    }),
  });

  const list = json?.req_1?.data?.body?.song?.list || [];
  return { tracks: list.map(toTrack), meta };
}

/**
 * Fetch a playlist's tracks.
 *
 * The API caps a single response at ~1000 songs, so anything larger is paged.
 * Pages are fetched one at a time rather than in parallel: a burst of
 * concurrent requests is the traffic shape that gets an IP throttled, and this
 * runs rarely enough that the extra seconds cost nothing.
 */
async function getPlaylist(disstid, { cookie, pageSize = 1000, maxSongs = 5000 } = {}) {
  const tracks = [];
  let title = null;
  let total = null;

  for (let begin = 0; begin < maxSongs; begin += pageSize) {
    const { json } = await callCgi({
      cookie,
      codeOf: (j) => j?.req_0?.code,
      url: cgiUrl({
        comm: { cv: 4747474, ct: 24, format: 'json' },
        req_0: {
          module: 'music.srfDissInfo.aiDissInfo',
          method: 'uniform_get_Dissinfo',
          param: {
            disstid: Number(disstid),
            enc_host_uin: '',
            tag: 1,
            userinfo: 1,
            song_begin: begin,
            song_num: pageSize,
          },
        },
      }),
    });

    const data = json?.req_0?.data;
    if (!data) break;
    if (title == null) title = data.dirinfo?.title ?? null;
    if (total == null) total = data.total_song_num ?? null;

    const page = data.songlist || [];
    if (!page.length) break;
    tracks.push(...page.map(toTrack));
    if (total != null && tracks.length >= total) break;
  }

  return { title, total, tracks };
}

/**
 * The `comm` block every call carries.
 *
 * This exact shape was measured resolving a track end to end in 1.2 seconds,
 * so it is left alone. Extra fields were tried once — g_tk, platform,
 * needNewCode, copied from a client that targets Android — and they did not
 * help, because the problem was never the request shape.
 */
function comm(uin, musicKey) {
  return {
    ...CLIENT,
    uin: String(uin),
    authst: musicKey,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
  };
}

/**
 * The vocals alone, when the platform has separated them.
 *
 * Tencent sells a separation product and publishes its output alongside the
 * song: the media id lands in `vs[9]` of the song detail, and the file is
 * fetched through the same vkey call as everything else. Measured at 100% of
 * a 25-song sample, so this is the ordinary case rather than a rarity.
 *
 * Two requests rather than one, because the media id is not on the row we
 * already hold and asking for it is what makes the file addressable. Null when
 * the song has no separated track, which the caller reports as "not available"
 * rather than as a failure.
 *
 * The file is roughly five times the size of a 128k mp3, so the caller should
 * expect the first byte later — measured at ~650ms against ~110ms.
 */
async function resolveVocals(mid, { cookie, uin, musicKey } = {}) {
  if (!uin || !musicKey) {
    const err = new Error('QQ 需要登录凭证才能解析播放地址');
    err.code = 'SOURCE_NEEDS_CREDENTIAL';
    err.platform = PLATFORM;
    throw err;
  }

  const { json: detail } = await callCgi({
    cookie,
    codeOf: (j) => j?.req_1?.code,
    url: `https://${HOST}/cgi-bin/musicu.fcg`,
    body: {
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail_yqq',
        param: { song_mid: mid },
      },
    },
  });

  // vs[9] is the separated-vocal media id. Absent on songs the platform has
  // not run through separation.
  const mediaMid = (detail?.req_1?.data?.track_info?.vs || [])[9];
  if (!mediaMid) return { url: null, reason: 'no-vocals', platformResult: null };

  const cdn = await getCdnHosts({ cookie, uin, musicKey });

  // O801 with the media mid, single rather than doubled: the special tracks
  // are named from the media id alone.
  const { json, meta } = await callCgi({
    cookie,
    codeOf: (j) => j?.req_1?.code,
    url: `https://${HOST}/cgi-bin/musicu.fcg`,
    body: {
      comm: comm(uin, musicKey),
      req_1: {
        module: 'music.vkey.GetVkey',
        method: 'UrlGetVkey',
        param: {
          uin: String(uin),
          filename: [`O801${mediaMid}.ogg`],
          guid: cdn.guid,
          songmid: [mid],
          songtype: [0],
          ctx: 0,
        },
      },
    },
  });

  const info = json?.req_1?.data?.midurlinfo?.[0];
  if (!info?.purl) {
    // 104003 here means the platform will not serve this file to this
    // identity. It cannot say on its own whether that is the account or this
    // one track -- the separated stem has its own permissions, and a song
    // whose normal audio plays can still have it withheld. The caller decides,
    // because only it can compare this against the ordinary request.
    const reason = info?.result === 104003 ? 'credential-expired' : 'unavailable';
    return { url: null, reason, platformResult: info?.result ?? null, meta };
  }
  const url = `${cdn.hosts[0]}${info.purl}&fromtag=3`.replace(/^http:\/\//, 'https://');
  return { url, reason: null, meta };
}

/**
 * Which CDN hosts to use, and the guid they are tied to.
 *
 * Cached, because the answer is about edge servers rather than about any
 * particular song — fetching it per track would double our request count for
 * nothing. The guid is cached with it since the CDN checks that the guid in
 * the URL is the one the vkey was signed for.
 */
async function getCdnHosts({ cookie, uin, musicKey, now = Date.now() } = {}) {
  if (cdnCache && now - cdnCache.at < CDN_TTL_MS) return cdnCache;
  // Several songs opened at once would otherwise each start their own lookup
  // on a cold cache, sending the very burst the cache exists to avoid. The
  // first caller does the work; the rest await the same promise.
  if (cdnInflight) return cdnInflight;

  cdnInflight = (async () => {
    const guid = crypto.randomUUID().replace(/-/g, '');
    const { json } = await callCgi({
      cookie,
      codeOf: (j) => j?.req_1?.code,
      url: `https://${HOST}/cgi-bin/musicu.fcg`,
      body: {
        comm: comm(uin, musicKey),
        req_1: {
          module: 'music.audioCdnDispatch.cdnDispatch',
          method: 'GetCdnDispatch',
          param: { guid, uid: '0', use_new_domain: 1, use_ipv6: 1 },
        },
      },
    });

    // Hosts beginning http://ws are websocket-style and do not serve plain
    // range requests, which the browser needs in order to seek.
    const all = json?.req_1?.data?.sip || [];
    const hosts = all.filter((s) => !s.startsWith('http://ws'));
    if (!hosts.length) {
      const err = new Error('QQ 没有返回可用的 CDN 地址');
      err.code = 'SOURCE_NO_CDN';
      err.platform = PLATFORM;
      throw err;
    }

    cdnCache = { hosts, guid, at: Date.now() };
    return cdnCache;
  })();

  try {
    return await cdnInflight;
  } finally {
    // Cleared on success and on failure alike: a failed lookup must not leave
    // a rejected promise behind that every later caller keeps re-awaiting.
    cdnInflight = null;
  }
}

/**
 * Resolve a playable URL for one song.
 *
 * Two calls, run in parallel: one for the CDN hosts and one for the signed
 * path. They must share a guid, and the result needs `&fromtag=3` appended —
 * miss either and the CDN answers 403 rather than saying what is wrong.
 *
 * Returns `{ url: null, reason: 'unavailable' }` when the platform will not
 * serve the track (no VIP, or delisted). That is a permission answer rather
 * than a failure, and callers present it differently.
 */
async function resolveUrl(mid, { cookie, uin, musicKey, tier = 'mp3_128' } = {}) {
  if (!uin || !musicKey) {
    const err = new Error('QQ 需要登录凭证才能解析播放地址');
    err.code = 'SOURCE_NEEDS_CREDENTIAL';
    err.platform = PLATFORM;
    throw err;
  }
  const t = TIERS[tier] || TIERS.mp3_128;

  // The CDN lookup is usually a cache hit, so this is normally a single call.
  const cdn = await getCdnHosts({ cookie, uin, musicKey });

  const { json, meta } = await callCgi({
    cookie,
    codeOf: (j) => j?.req_1?.code,
    url: `https://${HOST}/cgi-bin/musicu.fcg`,
    body: {
      comm: comm(uin, musicKey),
      req_1: {
        module: 'music.vkey.GetVkey',
        method: 'UrlGetVkey',
        param: {
          uin: String(uin),
          filename: [`${t.prefix}${mid}${mid}${t.ext}`],
          guid: cdn.guid,
          songmid: [mid],
          songtype: [0],
          ctx: 0,
        },
      },
    },
  });

  const info = json?.req_1?.data?.midurlinfo?.[0];
  if (!info?.purl) {
    // 104003 comes back for every track, free ones included, once the music
    // key has died. Reporting that as "needs VIP or delisted" sends the user
    // looking for a subscription problem when the fix is to reconnect.
    const reason = info?.result === 104003 ? 'credential-expired' : 'unavailable';
    return { url: null, reason, platformResult: info?.result ?? null, meta };
  }

  // fromtag is not part of purl but the CDN requires it; without it every
  // request comes back 403.
  const url = `${cdn.hosts[0]}${info.purl}&fromtag=3`.replace(/^http:\/\//, 'https://');
  return { url, reason: null, meta };
}

/** Drop the cached CDN dispatch. For tests, and for recovering from a bad host. */
function resetCdnCache() {
  cdnCache = null;
  cdnInflight = null;
}

/**
 * Membership status, and whether the credential still works.
 *
 * One call answers both questions, which is why it is worth making as soon as
 * a credential is stored. Saying "connected" without it would imply playback
 * works, and an account without a subscription signs in perfectly then fails
 * on most songs — 77% of the target playlist is VIP-only.
 *
 * Field names are from the reference client's VipIdentity model, confirmed
 * against a live response: `identity.vip` is the green-diamond flag, `send` is
 * the expiry date, and a non-zero `code` means the credential is no longer
 * accepted.
 */
async function getVipInfo({ cookie, uin, musicKey } = {}) {
  const { json, meta } = await callCgi({
    cookie,
    codeOf: (j) => j?.req_1?.code,
    url: `https://${HOST}/cgi-bin/musicu.fcg`,
    body: {
      comm: comm(uin, musicKey),
      req_1: { module: 'VipLogin.VipLoginInter', method: 'vip_login_base', param: {} },
    },
  });

  if (json?.req_1?.code !== 0) {
    return { ok: false, vipType: null, expiresOn: null, meta };
  }

  const data = json.req_1.data || {};
  const identity = data.identity || {};
  // Luxury green diamond outranks the plain one; either counts as "can play".
  const vipType = identity.HugeVip ? 2 : (identity.vip ? 1 : 0);
  return {
    ok: true,
    vipType,
    level: identity.level ?? null,
    // A plain YYYY-MM-DD string. Kept as given rather than parsed into a
    // timestamp — it is a calendar date, and turning it into an instant would
    // invent a timezone the platform never stated.
    expiresOn: identity.HugeVipEnd || data.send || null,
    meta,
  };
}

/**
 * Lyrics. No cookie needed.
 *
 * And that is exactly why this path needs the same restraint as the others,
 * not less. Carrying no credential means the request leaves as the server
 * rather than as a user, over the one address everybody shares — and these
 * platforms rate-limit by address. Measured without the pacing below: 7.2
 * requests a second sustained, ~26k an hour, all attributable to this machine.
 *
 * The in-flight cap alone does not bound that. It caps how many calls are open
 * at once (a burst of 30 sent 2 and refused 28), but two callers taking turns
 * stay under it forever, so rate has to be limited separately.
 */
async function getLyric(mid) {
  breaker.acquire(PLATFORM);
  const url = `https://${LYRIC_HOST}/lyric/fcgi-bin/fcg_query_lyric_new.fcg`
    + `?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`;

  let res;
  try {
    // Shares the module-level gap with every other QQ call, so the ceiling is
    // on this machine's traffic to the platform rather than on any one caller.
    await pace();
    res = await request(url, { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
  } finally {
    breaker.release(PLATFORM);
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`QQ 歌词接口返回 HTTP ${res.status}`);
    err.code = 'SOURCE_HTTP_ERROR';
    err.httpStatus = res.status;
    err.platform = PLATFORM;
    // Same reading as callCgi: 429 and 403 are how a gateway says "slow down".
    // Without this the breaker never learned anything from lyric traffic, so
    // the one path that runs as the server was also the one that could not
    // trip the protection meant to save it.
    if (res.status === 429 || res.status === 403) {
      err.breakerOpened = breaker.recordFailure(PLATFORM, 104604);
    }
    throw err;
  }

  // Reporting failures is only half of taking part. This call can be the probe
  // that ends a cooldown, and only a success clears the half-open state -- a
  // probe that answers and then says nothing leaves the breaker half-open for
  // good, where the next single throttle re-opens it for the full fifteen
  // minutes instead of taking three. Reproduced before this line existed.
  breaker.recordSuccess(PLATFORM);

  let json;
  try {
    // This endpoint sometimes wraps its JSON in a callback.
    json = JSON.parse(res.body.replace(/^\w+\(/, '').replace(/\)$/, ''));
  } catch {
    // A song with no lyrics is ordinary, so an unparseable body is reported as
    // "no lyrics" rather than as a failure. The status check above already
    // separated this from the platform being down.
    return { lyric: null, translation: null };
  }
  return {
    lyric: json.lyric || null,
    translation: json.trans || null,
    meta: { ms: res.ms, bytes: res.bytes },
  };
}

// --- 平台打标: the user's own playlists and their "我喜欢" ----------------
//
// Everything below acts as the user, with their credential, on their own
// account. Verified end to end on 2026-09-18/26 against a real WeChat-login
// account (19-digit uin); the module/method names come from the maintained
// reference client (L-1124/QQMusicApi) and were exercised one call at a time.

/** dirId of the account-wide favourites list. Fixed by the platform. */
const LIKES_DIR_ID = 201;

/** Cookie-bearing POST to musicu.fcg with the standard comm block. */
async function cgiPost(reqs, { cookie, uin, musicKey }) {
  return callCgi({
    cookie,
    codeOf: (j) => j?.req_1?.code,
    url: `https://${HOST}/cgi-bin/musicu.fcg`,
    body: { comm: comm(uin, musicKey), ...reqs },
  });
}

/**
 * The credential was refused. 1000 is "needs login" (an expired or wrong key);
 * anything else non-zero is reported with its code so the page can show it.
 */
function refused(code, what) {
  // No code at all means the body was not the shape expected (a gateway page,
  // a changed schema) -- said as such, not as "code undefined".
  if (code === undefined) {
    const bad = new Error(`QQ ${what}返回了无法识别的响应`);
    bad.code = 'SOURCE_BAD_RESPONSE';
    bad.status = 502;
    return bad;
  }
  const err = new Error(code === 1000
    ? 'QQ 音乐登录已过期，请到账户页重新连接'
    : `QQ ${what}失败 (code ${code})`);
  err.code = code === 1000 ? 'PLATFORM_CREDENTIAL_EXPIRED' : 'PLATFORM_CALL_FAILED';
  err.status = code === 1000 ? 401 : 502;
  err.platformCode = code;
  return err;
}

/**
 * The playlists this account created, plus the ones it collected.
 *
 * Both lists come back in one round trip. GetPlaylistByUin answers everything
 * at once (bFinish, no paging — 298 lists measured); the collected list is
 * asked for alongside it and dropped if that half is refused, because the
 * created lists are what the feature is for and a collected list is a bonus.
 *
 * "我喜欢" is an ordinary row here with dirId 201, and it is the row whose
 * tid names the favourites when they are read back.
 */
async function listMyPlaylists({ cookie, uin, musicKey, euin = null }) {
  const cred = { cookie, uin, musicKey };
  const { json } = await cgiPost({
    req_1: {
      module: 'music.musicasset.PlaylistBaseRead',
      method: 'GetPlaylistByUin',
      param: { uin: String(uin) },
    },
  }, cred);

  const code = json?.req_1?.code;
  if (code !== 0) throw refused(code, '读取歌单');

  const created = (json.req_1.data?.v_playlist || []).map((p) => ({
    ref: `qq:${p.tid}`,
    id: String(p.tid),
    dirId: p.dirId,
    name: p.dirName || '',
    count: p.songNum ?? null,
    cover: p.picUrl || null,
    isLikes: p.dirId === LIKES_DIR_ID,
    kind: 'created',
  }));

  // Favourites first, then the rest in the platform's own order.
  created.sort((a, b) => Number(b.isLikes) - Number(a.isLikes));

  // The collected (other people's) lists are keyed on the account's euin;
  // measured 2026-09-27, the numeric uin answers 80050 and nothing. A login
  // stores the euin; an older or pasted credential has none, and it is then
  // read once off any own playlist's dirinfo and handed back for storing.
  let effectiveEuin = euin || null;
  let euinResolved = false;
  if (!effectiveEuin && created.length) {
    const first = created.find((p) => !p.isLikes) || created[0];
    const { json: d } = await cgiPost({
      req_1: {
        module: 'music.srfDissInfo.DissInfo',
        method: 'CgiGetDiss',
        param: {
          disstid: first.isLikes ? 0 : Number(first.id), dirid: first.dirId,
          tag: true, userinfo: true, orderlist: true, song_begin: 0, song_num: 0,
        },
      },
    }, cred);
    effectiveEuin = d?.req_1?.data?.dirinfo?.encrypt_uin || null;
    euinResolved = Boolean(effectiveEuin);
  }

  // Different field names on this half (name/songnum). Its failure is not
  // the listing's failure: the created lists are what the feature is for.
  let collected = [];
  if (effectiveEuin) {
    const { json: f } = await cgiPost({
      req_1: {
        module: 'music.musicasset.PlaylistFavRead',
        method: 'CgiGetPlaylistFavInfo',
        param: { uin: effectiveEuin, offset: 0, size: 200 },
      },
    }, cred);
    if (f?.req_1?.code === 0) {
      collected = (f.req_1.data?.v_list || []).map((p) => ({
        ref: `qq:${p.tid}`,
        id: String(p.tid),
        dirId: p.dirId ?? null,
        name: p.name || '',
        count: p.songnum ?? null,
        cover: p.logo || null,
        isLikes: false,
        kind: 'collected',
      }));
    }
  }

  return { playlists: [...created, ...collected], euin: effectiveEuin, euinResolved };
}

/**
 * One playlist row with the fields a like needs.
 *
 * Distinct from toTrack, which is the import shape and drops `id`/`type` on
 * purpose (imports key on mid). AddSonglist wants the numeric id and the
 * type, and type is not always 0 — a real playlist returned type 1 rows.
 */
function toLikeable(s) {
  return {
    id: String(s.id),
    songType: Number.isInteger(s.type) ? s.type : 0,
    mid: s.mid || null,
    title: s.name || s.title || '',
    artist: (s.singer || []).map((x) => x.name).filter(Boolean).join('/'),
    durationSec: s.interval ?? null,
    vipOnly: Boolean(s.pay?.pay_play),
  };
}

/**
 * Every song in one of the user's playlists, as the user.
 *
 * CgiGetDiss rather than the anonymous import call: it is the one the
 * reference client uses for a credentialed read, and the only one measured to
 * return a private "我喜欢" (81/81 rows). For the favourites the platform wants
 * disstid 0 with the dirId; for any other list the tid plus its dirId.
 */
async function getPlaylistRows(tid, {
  cookie, uin, musicKey, dirId = null, pageSize = 1000, maxSongs = 5000,
} = {}) {
  const isLikes = dirId === LIKES_DIR_ID;
  const songs = [];
  let title = null;
  let total = null;

  for (let begin = 0; begin < maxSongs; begin += pageSize) {
    const { json } = await cgiPost({
      req_1: {
        module: 'music.srfDissInfo.DissInfo',
        method: 'CgiGetDiss',
        param: {
          disstid: isLikes ? 0 : Number(tid),
          ...(dirId != null ? { dirid: dirId } : {}),
          tag: true,
          userinfo: true,
          orderlist: true,
          song_begin: begin,
          song_num: pageSize,
        },
      },
    }, { cookie, uin, musicKey });

    const code = json?.req_1?.code;
    if (code !== 0) throw refused(code, '读取歌单内容');
    const data = json.req_1.data || {};
    if (title == null) title = data.dirinfo?.title ?? null;
    if (total == null) total = data.total_song_num ?? null;

    const page = data.songlist || [];
    if (!page.length) break;
    songs.push(...page.map(toLikeable));
    if (total != null && songs.length >= total) break;
  }

  // A private list answered to the wrong account comes back as a title and no
  // rows. Said plainly rather than shown as an empty playlist.
  if (!songs.length && total > 0) {
    const err = new Error('这个歌单被设为隐私，当前登录的账号读不到');
    err.code = 'PLATFORM_PLAYLIST_PRIVATE';
    err.status = 403;
    throw err;
  }
  return { title, total, songs };
}

/**
 * Which of these songs are already in "我喜欢". Batched; answers a map of
 * id → boolean so callers never confuse "not asked" with "not liked".
 */
async function likedMap(ids, { cookie, uin, musicKey }) {
  const out = new Map();
  const list = [...new Set(ids.map(String))];
  for (let i = 0; i < list.length; i += 50) {
    const slice = list.slice(i, i + 50);
    const { json } = await cgiPost({
      req_1: {
        module: 'music.musicasset.SongFavRead',
        method: 'IsSongFanById',
        param: { v_songId: slice.map(Number) },
      },
    }, { cookie, uin, musicKey });
    const code = json?.req_1?.code;
    if (code !== 0) throw refused(code, '查询喜欢状态');
    const fan = json.req_1.data?.m_fan || {};
    for (const id of slice) out.set(id, Boolean(fan[id]));
  }
  return out;
}

/**
 * Like one song: add it to "我喜欢".
 *
 * The success code is not trusted. A repeated add, and a delete with the
 * wrong type, both answer retCode 0 having changed nothing; what tells a real
 * write apart is `result.dirId === 201` with a real tid — and even that is
 * only a hint. The state is read back and is the answer.
 */
async function likeSong({ id, songType = 0 }, { cookie, uin, musicKey }) {
  const { json } = await cgiPost({
    req_1: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method: 'AddSonglist',
      param: {
        dirId: LIKES_DIR_ID,
        tid: 0,
        bFmtUtf8: true,
        v_songInfo: [{ songId: Number(id), songType: Number(songType) || 0 }],
      },
    },
  }, { cookie, uin, musicKey });

  const code = json?.req_1?.code;
  if (code !== 0) throw refused(code, '点赞');
  const data = json.req_1.data || {};
  if (data.retCode !== 0) {
    const detail = data.msg ? `: ${data.msg}` : '';
    const err = new Error(`QQ 点赞被拒绝 (retCode ${data.retCode}${detail})`);
    err.code = 'PLATFORM_LIKE_REJECTED';
    err.status = 502;
    throw err;
  }

  const after = await likedMap([id], { cookie, uin, musicKey });
  if (!after.get(String(id))) {
    const err = new Error('QQ 返回成功但歌曲并未进入「我喜欢」');
    err.code = 'PLATFORM_LIKE_UNVERIFIED';
    err.status = 502;
    throw err;
  }
  return { ok: true, changed: data.result?.dirId === LIKES_DIR_ID };
}

/**
 * Unlike one song: remove it from "我喜欢".
 *
 * The platform's answer is not trusted at all here. Measured 2026-09-26: with
 * the song's own type (1) the call returned retCode 0 four times in a row and
 * removed nothing; with songType 0 it removed the song. So 0 goes first, the
 * state is read back, and the song's own type is tried only if it is still
 * there. Whichever way, the read-back is the answer.
 */
async function unlikeSong({ id, songType = 0 }, { cookie, uin, musicKey }) {
  // One attempt: the platform's code, and whether the song is really gone.
  // A refusal other than "login expired" does not end things -- the second
  // type still gets its turn, because a refused type-0 delete and a silently
  // ignored one are the same outcome from here.
  const attempt = async (type) => {
    const { json } = await cgiPost({
      req_1: {
        module: 'music.musicasset.PlaylistDetailWrite',
        method: 'DelSonglist',
        param: {
          dirId: LIKES_DIR_ID,
          tid: 0,
          bFmtUtf8: true,
          v_songInfo: [{ songId: Number(id), songType: type }],
        },
      },
    }, { cookie, uin, musicKey });
    const code = json?.req_1?.code;
    // A lapsed login or a body that is not the expected shape ends things at
    // once: the second type would be a second write against a session that
    // is already broken. Any other refusal is recorded and the next type
    // still gets its turn.
    if (code === 1000 || code === undefined) throw refused(code, '取消点赞');
    const after = await likedMap([id], { cookie, uin, musicKey });
    return { removed: !after.get(String(id)), code };
  };

  const first = await attempt(0);
  if (first.removed) return { ok: true };
  const own = Number(songType) || 0;
  const second = own !== 0 ? await attempt(own) : null;
  if (second && second.removed) return { ok: true };

  const codes = [first.code, second?.code].filter((c) => c !== undefined && c !== 0);
  const err = new Error(codes.length
    ? `QQ 取消点赞失败 (code ${codes.join('/')})`
    : 'QQ 返回成功但歌曲仍在「我喜欢」里');
  err.code = 'PLATFORM_UNLIKE_UNVERIFIED';
  err.status = 502;
  throw err;
}

module.exports = {
  PLATFORM,
  search,
  getPlaylist,
  resolveUrl,
  resolveVocals,
  getVipInfo,
  getLyric,
  toTrack,
  resetCdnCache,
  TIERS,
  // 平台打标
  LIKES_DIR_ID,
  listMyPlaylists,
  getPlaylistRows,
  likedMap,
  likeSong,
  unlikeSong,
  toLikeable,
};
