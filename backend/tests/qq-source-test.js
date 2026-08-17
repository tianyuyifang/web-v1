/**
 * qqSource tests — offline by default, no DB.
 * Run: node tests/qq-source-test.js
 *
 * Network calls are opt-in because they spend real quota against an endpoint
 * that rate-limits by IP, and that limit is shared by every user of the site:
 *   QQ_COOKIE="..." QQ_UIN="..." node tests/qq-source-test.js --live
 */
const assert = require('assert');
const qq = require('../src/services/sources/qqSource');
const breaker = require('../src/services/musicSourceBreaker');

// --- toTrack, against rows in the shape the API really returns -------------
const row = {
  mid: '000S5SKd2IYzXh',
  name: '春天的临终',
  singer: [{ name: '裘德' }],
  interval: 282,
  album: { name: '给你的信' },
  pay: { pay_play: 0 },
};

let t = qq.toTrack(row);
assert.strictEqual(t.source, 'QQ');
assert.strictEqual(t.externalId, '000S5SKd2IYzXh', 'mid becomes externalId');
assert.strictEqual(t.title, '春天的临终');
assert.strictEqual(t.artist, '裘德');
assert.strictEqual(t.durationSec, 282);
assert.strictEqual(t.vipOnly, false, 'pay_play 0 is free');

// Co-performers joined with '/', which songKeyService then splits and sorts,
// so QQ's ordering does not leak into the mapping key.
t = qq.toTrack({ ...row, singer: [{ name: '汪苏泷' }, { name: '赵露思' }] });
assert.strictEqual(t.artist, '汪苏泷/赵露思');

// 77% of the target playlist is VIP-only, so this flag decides whether review
// can predict "this will not play" before anyone tries it.
assert.strictEqual(qq.toTrack({ ...row, pay: { pay_play: 1 } }).vipOnly, true);

// Fields really do go missing on some rows; a throw here would kill a whole
// import batch over one bad record.
const sparse = qq.toTrack({ mid: 'x', name: 'y' });
assert.strictEqual(sparse.artist, '', 'missing singer list');
assert.strictEqual(sparse.durationSec, null, 'missing interval');
assert.strictEqual(sparse.album, null, 'missing album');
assert.strictEqual(sparse.vipOnly, false, 'missing pay block');

// --- credentials are required before any request goes out ------------------
(async () => {
  breaker.reset(); qq.resetCdnCache();
  await assert.rejects(
    () => qq.resolveUrl('mid', {}),
    (e) => e.code === 'SOURCE_NEEDS_CREDENTIAL',
    'resolveUrl refuses without uin/musicKey rather than firing a doomed request',
  );

  // --- an open breaker short-circuits every endpoint ----------------------
  // Not just the one that failed: the block is per IP, so continuing to call
  // the others is what extends it.
  breaker.reset(); qq.resetCdnCache();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure('qq', 104604);

  for (const [label, call] of [
    ['search', () => qq.search('x', { cookie: 'c' })],
    ['getPlaylist', () => qq.getPlaylist('1', { cookie: 'c' })],
    ['getLyric', () => qq.getLyric('mid')],
    ['resolveUrl', () => qq.resolveUrl('mid', { cookie: 'c', uin: '1', musicKey: 'k' })],
  ]) {
    await assert.rejects(call, (e) => e.code === 'SOURCE_UNAVAILABLE',
      `${label} is blocked while the breaker is open`);
  }
  breaker.reset(); qq.resetCdnCache();

  // --- responses the platform really sends when unhappy -------------------
  // Served from a local stub so these run offline and spend no quota.
  const http = require('http');
  const https = require('https');
  const realRequest = https.request;
  let mode = 'ok';
  let stubHits = 0;
  let captured = [];
  const srv = http.createServer((req, res) => {
    stubHits += 1;
    const send = (status, body, type) => {
      res.writeHead(status, type ? { 'content-type': type } : undefined);
      res.end(body);
    };

    // Resolution is two calls against the same endpoint, told apart by their
    // body, so the request has to be read before answering.
    let reqBody = '';
    req.on('data', (c) => { reqBody += c; });
    req.on('end', () => {
      captured.push({ method: req.method, url: req.url, body: reqBody });
      const isCdn = reqBody.includes('cdnDispatch');
      const cdnOk = () => send(200, JSON.stringify({ req_1: { code: 0, data: { sip: ['http://cdn.qq.com/'] } } }));
      const vkeyOk = () => send(200, JSON.stringify({ req_1: { code: 0, data: { midurlinfo: [{ purl: 'a.mp3?vkey=X' }] } } }));

      switch (mode) {
        case 'capture': return isCdn ? cdnOk() : vkeyOk();
        // A slow dispatch widens the window in which concurrent callers could
        // each start their own lookup.
        case 'slowcdn': return isCdn ? setTimeout(cdnOk, 40) : vkeyOk();
        case 'cdnfail': return isCdn ? send(500, 'boom') : vkeyOk();
        // What the retired endpoint answers — for everyone, from any address.
        case 'dead': return isCdn ? cdnOk()
          : send(200, JSON.stringify({ req_1: { code: 104009, data: { midurlinfo: [{ purl: '' }] } } }));
        // Platform throttling the vkey call. Slow, so concurrent callers
        // overlap instead of queueing up neatly one after another.
        case 'rate': return isCdn ? cdnOk() : setTimeout(
          () => send(200, JSON.stringify({ req_1: { code: 104604, data: { midurlinfo: [{ purl: '' }] } } })), 30,
        );
        default: return legacy(send, res);
      }
    });
  });

  // Cases that predate the two-call resolve and answer the same body to
  // whichever call arrives.
  function legacy(send, res) {
    switch (mode) {
      case 'resolveok': return send(200, JSON.stringify({ req_1: { code: 0, data: { sip: ['http://cdn.qq.com/'], midurlinfo: [{ purl: 'a.m4a?vkey=X' }] } } }));
      // An outage that answers with a JSON-ish body. Before the status check
      // this parsed cleanly and came back as "no purl", i.e. as though the
      // track needed VIP — a platform outage would have been written into the
      // mapping table as a permission problem.
      case 'http503': return send(503, '{"code":-1}', 'application/json');
      case 'http429': return send(429, '{}');
      case 'html': return send(200, '<html>blocked</html>', 'text/html');
      case 'nulldata': return send(200, JSON.stringify({ req_1: { code: 0, data: { sip: ['http://cdn.qq.com/'], midurlinfo: null } } }));
      // Empty sip with a usable purl is the signature of a throttled IP.
      // Concatenating them yields a path with no host.
      case 'nosip': return send(200, JSON.stringify({ req_1: { code: 0, data: { sip: [], midurlinfo: [{ purl: 'song.m4a?vkey=X' }] } } }));
      case 'wshost': return send(200, JSON.stringify({ req_1: { code: 0, data: { sip: ['http://ws.stream.qq.com/', 'http://cdn.qq.com/'], midurlinfo: [{ purl: 'song.m4a?vkey=X' }] } } }));
      case 'emptysearch': return send(200, JSON.stringify({ req_1: { code: 0, data: { body: { song: { list: [] } } } } }));
      case 'emptyplaylist': return send(200, JSON.stringify({ req_0: { code: 0, data: { dirinfo: { title: 'T' }, total_song_num: 0, songlist: [] } } }));
      // Always returns a full page: paging must stop on maxSongs rather than
      // trusting the platform to run out of rows.
      case 'endless': return send(200, JSON.stringify({ req_0: { code: 0, data: { dirinfo: { title: 'T' }, total_song_num: 999999, songlist: Array.from({ length: 1000 }, (_, i) => ({ mid: `m${i}`, name: 's', singer: [], interval: 1 })) } } }));
      case 'lyric503': return send(503, 'nope');
      case 'lyricempty': return send(200, 'MusicJsonCallback({"retcode":0})');
      // Headers, a partial body, then the socket dies.
      case 'killmid': {
        res.writeHead(200);
        res.write('{"req_1":{"code":0,');
        setTimeout(() => res.socket && res.socket.destroy(), 20);
        return undefined;
      }
      default: return send(200, '{}');
    }
  }
  await new Promise((r) => srv.listen(0, r));
  const { port } = srv.address();
  // agent:undefined because the module's keep-alive agent is an https.Agent and
  // refuses a http: stub. Socket reuse is not what these cases are exercising.
  https.request = (o, cb) => http.request({
    ...o, agent: undefined, hostname: '127.0.0.1', port, protocol: 'http:',
  }, cb);

  const CRED = { cookie: 'c', uin: '1', musicKey: 'k' };
  try {
    mode = 'http503'; breaker.reset(); qq.resetCdnCache();
    await assert.rejects(() => qq.resolveUrl('mid', CRED),
      (e) => e.code === 'SOURCE_HTTP_ERROR' && e.httpStatus === 503,
      'an HTTP error is an error, not a "this song is unavailable" answer');

    mode = 'html'; breaker.reset(); qq.resetCdnCache();
    await assert.rejects(() => qq.resolveUrl('mid', CRED),
      (e) => e.code === 'SOURCE_BAD_RESPONSE', 'an HTML error page is not silently swallowed');

    // A gateway saying 429 carries no platform code, but it is still the
    // platform telling us to stop.
    mode = 'http429'; breaker.reset(); qq.resetCdnCache();
    for (let i = 0; i < 3; i += 1) { try { await qq.resolveUrl('mid', CRED); } catch { /* counted */ } }
    assert.strictEqual(breaker.status('qq').open, true, '429 feeds the breaker');

    // These two are genuine "platform will not serve this track" answers and
    // must stay non-throwing, or one missing song would fail a whole batch.
    mode = 'nulldata'; breaker.reset(); qq.resetCdnCache();
    assert.strictEqual((await qq.resolveUrl('mid', CRED)).url, null, 'data:null tolerated');
    // No CDN hosts means there is nowhere to point the browser. Concatenating
    // an empty host with the path would yield a URL with no origin, so this
    // fails loudly rather than handing back something broken.
    mode = 'nosip'; breaker.reset(); qq.resetCdnCache();
    await assert.rejects(() => qq.resolveUrl('mid', CRED),
      (e) => e.code === 'SOURCE_NO_CDN', 'no CDN hosts is an error, not a silent bad URL');

    mode = 'wshost'; breaker.reset(); qq.resetCdnCache();
    const resolved = await qq.resolveUrl('mid', CRED);
    assert.ok(!resolved.url.includes('ws.stream'), 'skips ws hosts, which do not serve ranges');
    assert.ok(resolved.url.startsWith('https://'),
      'http is rewritten to https, or the browser blocks it as mixed content');

    mode = 'emptysearch'; breaker.reset(); qq.resetCdnCache();
    assert.deepStrictEqual((await qq.search('zzz', { cookie: 'c' })).tracks, [], 'no results is not an error');
    mode = 'emptyplaylist'; breaker.reset(); qq.resetCdnCache();
    assert.deepStrictEqual((await qq.getPlaylist('1', { cookie: 'c' })).tracks, [], 'empty playlist terminates');

    mode = 'endless'; breaker.reset(); qq.resetCdnCache();
    const capped = await qq.getPlaylist('1', { cookie: 'c', pageSize: 1000, maxSongs: 3000 });
    assert.strictEqual(capped.tracks.length, 3000, 'paging is bounded by maxSongs');

    mode = 'lyric503'; breaker.reset(); qq.resetCdnCache();
    await assert.rejects(() => qq.getLyric('mid'), (e) => e.code === 'SOURCE_HTTP_ERROR',
      'a lyric outage is distinguishable from a song that has no lyrics');
    mode = 'lyricempty'; breaker.reset(); qq.resetCdnCache();
    assert.strictEqual((await qq.getLyric('mid')).lyric, null, 'no lyrics is not a failure');

    // --- a burst must not all reach the platform --------------------------
    // Several users pressing play at once used to send every request straight
    // through: the breaker opened only after all of them had been sent, which
    // is the traffic shape that gets an IP throttled in the first place.
    mode = 'rate'; breaker.reset(); qq.resetCdnCache(); stubHits = 0;
    const burst = await Promise.allSettled(
      Array.from({ length: 20 }, () => qq.resolveUrl('mid', CRED)),
    );
    assert.ok(stubHits <= breaker.DEFAULTS.maxInFlight + 2,
      `a 20-way burst reached the platform ${stubHits} times, expected ~${breaker.DEFAULTS.maxInFlight} plus the shared CDN lookup`);
    assert.ok(burst.some((r) => r.status === 'rejected' && r.reason.code === 'SOURCE_BUSY'),
      'excess callers are turned away locally rather than on the wire');
    assert.strictEqual(breaker.status('qq').inFlight, 0, 'every slot was released');

    // Slots must come back on the success path too, or the feature would seize
    // up after maxInFlight successful plays.
    mode = 'resolveok'; breaker.reset(); qq.resetCdnCache();
    for (let i = 0; i < 5; i += 1) await qq.resolveUrl('mid', CRED);
    assert.strictEqual(breaker.status('qq').inFlight, 0, 'slots released after successes');

    // --- a socket that dies mid-body ---------------------------------------
    // The failure arrives on the response, not the request. Unhandled, the
    // promise never settles and the caller keeps its breaker slot forever.
    mode = 'killmid'; breaker.reset(); qq.resetCdnCache();
    const started = Date.now();
    await assert.rejects(() => qq.resolveUrl('mid', CRED), () => true,
      'a truncated response settles instead of hanging');
    assert.ok(Date.now() - started < 5000, 'settles immediately, not after the 12s timeout');
    assert.strictEqual(breaker.status('qq').inFlight, 0, 'slot released after a dead socket');

    // --- the request the platform actually accepts -------------------------
    // The retired endpoint answers 104009 for everyone regardless of address,
    // which is easy to misread as a block on your own IP. These pin the shape
    // that works, so a silent drift back cannot happen unnoticed.
    mode = 'capture'; breaker.reset(); qq.resetCdnCache(); captured = [];
    const built = await qq.resolveUrl('MID1', CRED);
    assert.strictEqual(captured.length, 2, 'one dispatch call and one vkey call');
    assert.ok(captured.every((c) => c.method === 'POST'), 'POST, not GET with data in the query');

    const [cdnReq, vkeyReq] = captured.map((c) => JSON.parse(c.body));
    assert.strictEqual(cdnReq.req_1.module, 'music.audioCdnDispatch.cdnDispatch');
    assert.strictEqual(vkeyReq.req_1.module, 'music.vkey.GetVkey', 'not the retired GetVkeyServer');
    assert.strictEqual(vkeyReq.req_1.method, 'UrlGetVkey', 'not the retired CgiGetVkey');
    // The CDN validates that the guid in the URL is the one the vkey was
    // signed for; a mismatch is answered with 403 and no explanation.
    assert.strictEqual(cdnReq.req_1.param.guid, vkeyReq.req_1.param.guid, 'both calls share a guid');
    assert.match(vkeyReq.req_1.param.guid, /^[0-9a-f]{32}$/, 'guid is a uuid hex, not a fixed digit string');
    assert.strictEqual(vkeyReq.comm.authst, CRED.musicKey, 'music key travels in comm.authst');
    // Not part of purl, but the CDN refuses the request without it.
    assert.ok(built.url.includes('&fromtag=3'), 'fromtag is appended');
    assert.ok(built.url.startsWith('https://'), 'https, or the browser blocks it as mixed content');

    // --- the CDN lookup is cached ------------------------------------------
    // It describes edge servers, not a song, so fetching it per track would
    // double outbound traffic for nothing.
    mode = 'capture'; breaker.reset(); qq.resetCdnCache(); captured = [];
    for (let i = 0; i < 4; i += 1) await qq.resolveUrl(`M${i}`, CRED);
    const dispatches = captured.filter((c) => c.body.includes('cdnDispatch')).length;
    assert.strictEqual(dispatches, 1, '4 songs cost 1 dispatch call, not 4');

    // Cold-start callers must share one lookup rather than each starting their
    // own — otherwise the cache's first moment produces the exact burst it
    // exists to prevent.
    mode = 'slowcdn'; breaker.reset(); qq.resetCdnCache(); captured = [];
    await Promise.allSettled(Array.from({ length: 8 }, (_, i) => qq.resolveUrl(`C${i}`, CRED)));
    assert.strictEqual(captured.filter((c) => c.body.includes('cdnDispatch')).length, 1,
      'a cold 8-way burst still makes exactly one dispatch call');

    // A failed lookup must not leave a rejected promise behind for everyone
    // afterwards to keep awaiting.
    mode = 'cdnfail'; breaker.reset(); qq.resetCdnCache();
    await assert.rejects(() => qq.resolveUrl('X', CRED), () => true, 'a dispatch failure surfaces');
    mode = 'capture'; captured = [];
    assert.ok((await qq.resolveUrl('Y', CRED)).url, 'the next call recovers');

    // --- 104009 is not a rate limit ----------------------------------------
    // It is what the retired endpoint returns. Counting it as throttling let a
    // dead endpoint disable the feature for fifteen minutes at a time.
    mode = 'dead'; breaker.reset(); qq.resetCdnCache();
    for (let i = 0; i < 6; i += 1) { try { await qq.resolveUrl(`D${i}`, CRED); } catch { /* ignored */ } }
    assert.strictEqual(breaker.status('qq').open, false, '104009 never opens the breaker');
    const deadAnswer = await qq.resolveUrl('D', CRED);
    assert.strictEqual(deadAnswer.url, null, 'and it reads as "cannot play this track"');
    assert.strictEqual(deadAnswer.reason, 'unavailable');
  } finally {
    https.request = realRequest;
    srv.close();
    breaker.reset(); qq.resetCdnCache();
  }

  // --- live checks --------------------------------------------------------
  if (process.argv.includes('--live')) {
    const cookie = process.env.QQ_COOKIE;
    const uin = process.env.QQ_UIN;

    const ly = await qq.getLyric('0012h8671XIN4F'); // 达尔文 - 蔡健雅
    assert.ok(/\[\d\d:\d\d/.test(ly.lyric || ''), 'lyrics come back timestamped');

    if (cookie) {
      const s = await qq.search('达尔文 蔡健雅', { cookie, limit: 3 });
      assert.ok(s.tracks.length > 0, 'search returns rows');
      assert.ok(s.tracks.every((x) => x.externalId && x.title), 'every row is usable');
    }
    if (cookie && uin) {
      const r = await qq.resolveUrl('0012h8671XIN4F', { cookie, uin, musicKey: process.env.QQ_KEY });
      // null is a legitimate answer (no VIP / delisted), so assert only on shape.
      assert.ok(r.url === null || r.url.startsWith('https://'),
        'resolved URLs are https, never mixed content');
    }
    console.log('live checks passed');
  }

  console.log('qq-source tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
