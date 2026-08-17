/**
 * QQ Music adapter: search, playlist, lyric, and playback-URL resolution.
 *
 * Only the URL is resolved here. The audio itself is fetched by the listener's
 * browser straight from the CDN, which is what keeps this feature off our
 * bandwidth bill — roughly 2 KB of traffic per song instead of 3-5 MB. The CDN
 * sends permissive CORS headers and honours range requests, so the browser can
 * seek and decode normally.
 *
 * Every request goes through the circuit breaker. These endpoints rate-limit by
 * IP, all users share this server's address, and a retry loop takes the feature
 * down for everyone at once — see musicSourceBreaker.
 *
 * Request shapes here are copied from a working client (jsososo/QQMusicApi,
 * L-1124/QQMusicApi) rather than reconstructed. Two URL-level fields, loginUin
 * and g_tk, are what the vkey service actually authenticates on; without them
 * it answers 104009 no matter how correct the JSON body is.
 */
const https = require('https');
const breaker = require('../musicSourceBreaker');

const PLATFORM = 'qq';
const HOST = 'u.y.qq.com';
const LYRIC_HOST = 'c.y.qq.com';
const TIMEOUT_MS = 12000;
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

function request(url, { headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const startedAt = Date.now();
    const req = https.request({
      hostname: host || u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      agent,
      headers: {
        // The vkey service checks Referer; a bare request is refused.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://y.qq.com/',
        Origin: 'https://y.qq.com',
        ...headers,
      },
    }, (res) => {
      let body = '';
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
        body += c;
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        body,
        ms: Date.now() - startedAt,
        bytes: Buffer.byteLength(body),
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
    req.end();
  });
}

/**
 * One musicu.fcg call, with the breaker wrapped around it.
 *
 * `codeOf` pulls the platform's own status out of the response so the breaker
 * can tell "you are being throttled" apart from "that song needs VIP". Only the
 * former should ever stop traffic; tripping on the latter would disable
 * playback over ordinary missing songs.
 */
async function callCgi({ url, cookie, codeOf }) {
  // Claims an in-flight slot as well as checking the breaker, so a burst of
  // simultaneous callers cannot all reach the platform before the first
  // failure is recorded.
  breaker.acquire(PLATFORM);

  let res;
  try {
    res = await request(url, cookie ? { headers: { Cookie: cookie } } : {});
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
 * Resolve a playable URL for one song.
 *
 * loginUin and g_tk sit in the query string, not the JSON body. They are what
 * the vkey service authenticates on, and leaving them out produces 104009 with
 * an empty sip list — the same response an IP block gives, which makes this
 * easy to misdiagnose. The echoed data.uin being blank is normal and does not
 * mean the request failed.
 *
 * Returns null when the platform simply will not serve this track (no VIP, or
 * delisted). That is a permission answer, not an error, and callers show it
 * differently from a failure.
 */
async function resolveUrl(mid, { cookie, uin, musicKey, tier = 'm4a' } = {}) {
  if (!uin || !musicKey) {
    const err = new Error('QQ 需要登录凭证才能解析播放地址');
    err.code = 'SOURCE_NEEDS_CREDENTIAL';
    err.platform = PLATFORM;
    throw err;
  }
  const t = TIERS[tier] || TIERS.m4a;
  // Any stable 10-digit value works; it only has to match across the session.
  const guid = '1234567890';

  const { json, meta } = await callCgi({
    cookie,
    codeOf: (j) => j?.req_0?.code,
    url: cgiUrl(
      {
        req_0: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            filename: [`${t.prefix}${mid}${mid}${t.ext}`],
            guid,
            songmid: [mid],
            songtype: [0],
            uin: String(uin),
            loginflag: 1,
            platform: '20',
          },
        },
        comm: { uin: String(uin), format: 'json', ct: 19, cv: 0, authst: musicKey },
      },
      { '-': 'getplaysongvkey', g_tk: '5381', loginUin: String(uin), hostUin: '0', platform: 'yqq.json', needNewCode: '0' },
    ),
  });

  const data = json?.req_0?.data;
  const info = data?.midurlinfo?.[0];
  if (!info?.purl) {
    return { url: null, reason: 'unavailable', platformResult: info?.result ?? null, meta };
  }

  // sip entries starting with http://ws are websocket-style hosts that do not
  // serve plain range requests; pick a normal CDN host instead.
  const sip = (data.sip || []).find((s) => !s.startsWith('http://ws')) || data.sip?.[0] || '';
  // An empty sip list alongside a usable purl is the signature of a throttled
  // IP. Returning purl on its own would hand the browser a path with no host,
  // so treat it as unavailable rather than emitting a broken URL.
  if (!sip) {
    return { url: null, reason: 'unavailable', platformResult: info?.result ?? null, meta };
  }
  // Pages are served over https, so a http:// audio URL would be blocked as
  // mixed content. The CDN serves the same object over https.
  const url = `${sip}${info.purl}`.replace(/^http:\/\//, 'https://');
  return { url, reason: null, meta };
}

/** Lyrics. No cookie needed. */
async function getLyric(mid) {
  breaker.acquire(PLATFORM);
  const url = `https://${LYRIC_HOST}/lyric/fcgi-bin/fcg_query_lyric_new.fcg`
    + `?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`;

  let res;
  try {
    res = await request(url, { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
  } finally {
    breaker.release(PLATFORM);
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`QQ 歌词接口返回 HTTP ${res.status}`);
    err.code = 'SOURCE_HTTP_ERROR';
    err.httpStatus = res.status;
    err.platform = PLATFORM;
    throw err;
  }

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

module.exports = {
  PLATFORM,
  search,
  getPlaylist,
  resolveUrl,
  getLyric,
  toTrack,
  TIERS,
};
