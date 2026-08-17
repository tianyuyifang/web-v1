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
  breaker.reset();
  await assert.rejects(
    () => qq.resolveUrl('mid', {}),
    (e) => e.code === 'SOURCE_NEEDS_CREDENTIAL',
    'resolveUrl refuses without uin/musicKey rather than firing a doomed request',
  );

  // --- an open breaker short-circuits every endpoint ----------------------
  // Not just the one that failed: the block is per IP, so continuing to call
  // the others is what extends it.
  breaker.reset();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure('qq', 104009);

  for (const [label, call] of [
    ['search', () => qq.search('x', { cookie: 'c' })],
    ['getPlaylist', () => qq.getPlaylist('1', { cookie: 'c' })],
    ['getLyric', () => qq.getLyric('mid')],
    ['resolveUrl', () => qq.resolveUrl('mid', { cookie: 'c', uin: '1', musicKey: 'k' })],
  ]) {
    await assert.rejects(call, (e) => e.code === 'SOURCE_UNAVAILABLE',
      `${label} is blocked while the breaker is open`);
  }
  breaker.reset();

  // --- responses the platform really sends when unhappy -------------------
  // Served from a local stub so these run offline and spend no quota.
  const http = require('http');
  const https = require('https');
  const realRequest = https.request;
  let mode = 'ok';
  let stubHits = 0;
  const srv = http.createServer((req, res) => {
    stubHits += 1;
    const send = (status, body, type) => {
      res.writeHead(status, type ? { 'content-type': type } : undefined);
      res.end(body);
    };
    switch (mode) {
      // Deliberately slow, so concurrent callers overlap rather than queueing
      // up neatly one after another.
      case 'rate': return setTimeout(() => send(200, JSON.stringify({ req_0: { code: 104009, data: { sip: [], midurlinfo: [{ purl: '' }] } } })), 30);
      case 'resolveok': return send(200, JSON.stringify({ req_0: { code: 0, data: { sip: ['http://cdn.qq.com/'], midurlinfo: [{ purl: 'a.m4a?vkey=X' }] } } }));
      // An outage that answers with a JSON-ish body. Before the status check
      // this parsed cleanly and came back as "no purl", i.e. as though the
      // track needed VIP — a platform outage would have been written into the
      // mapping table as a permission problem.
      case 'http503': return send(503, '{"code":-1}', 'application/json');
      case 'http429': return send(429, '{}');
      case 'html': return send(200, '<html>blocked</html>', 'text/html');
      case 'nulldata': return send(200, JSON.stringify({ req_0: { code: 0, data: null } }));
      // Empty sip with a usable purl is the signature of a throttled IP.
      // Concatenating them yields a path with no host.
      case 'nosip': return send(200, JSON.stringify({ req_0: { code: 0, data: { sip: [], midurlinfo: [{ purl: 'song.m4a?vkey=X' }] } } }));
      case 'wshost': return send(200, JSON.stringify({ req_0: { code: 0, data: { sip: ['http://ws.stream.qq.com/', 'http://cdn.qq.com/'], midurlinfo: [{ purl: 'song.m4a?vkey=X' }] } } }));
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
        res.write('{"req_0":{"code":0,');
        setTimeout(() => res.socket && res.socket.destroy(), 20);
        return undefined;
      }
      default: return send(200, '{}');
    }
  });
  await new Promise((r) => srv.listen(0, r));
  const { port } = srv.address();
  // agent:undefined because the module's keep-alive agent is an https.Agent and
  // refuses a http: stub. Socket reuse is not what these cases are exercising.
  https.request = (o, cb) => http.request({
    ...o, agent: undefined, hostname: '127.0.0.1', port, protocol: 'http:',
  }, cb);

  const CRED = { cookie: 'c', uin: '1', musicKey: 'k' };
  try {
    mode = 'http503'; breaker.reset();
    await assert.rejects(() => qq.resolveUrl('mid', CRED),
      (e) => e.code === 'SOURCE_HTTP_ERROR' && e.httpStatus === 503,
      'an HTTP error is an error, not a "this song is unavailable" answer');

    mode = 'html'; breaker.reset();
    await assert.rejects(() => qq.resolveUrl('mid', CRED),
      (e) => e.code === 'SOURCE_BAD_RESPONSE', 'an HTML error page is not silently swallowed');

    // A gateway saying 429 carries no platform code, but it is still the
    // platform telling us to stop.
    mode = 'http429'; breaker.reset();
    for (let i = 0; i < 3; i += 1) { try { await qq.resolveUrl('mid', CRED); } catch { /* counted */ } }
    assert.strictEqual(breaker.status('qq').open, true, '429 feeds the breaker');

    // These two are genuine "platform will not serve this track" answers and
    // must stay non-throwing, or one missing song would fail a whole batch.
    mode = 'nulldata'; breaker.reset();
    assert.strictEqual((await qq.resolveUrl('mid', CRED)).url, null, 'data:null tolerated');
    mode = 'nosip'; breaker.reset();
    assert.strictEqual((await qq.resolveUrl('mid', CRED)).url, null,
      'purl with no host is unavailable, never a malformed URL');

    mode = 'wshost'; breaker.reset();
    const resolved = await qq.resolveUrl('mid', CRED);
    assert.ok(!resolved.url.includes('ws.stream'), 'skips ws hosts, which do not serve ranges');
    assert.ok(resolved.url.startsWith('https://'),
      'http is rewritten to https, or the browser blocks it as mixed content');

    mode = 'emptysearch'; breaker.reset();
    assert.deepStrictEqual((await qq.search('zzz', { cookie: 'c' })).tracks, [], 'no results is not an error');
    mode = 'emptyplaylist'; breaker.reset();
    assert.deepStrictEqual((await qq.getPlaylist('1', { cookie: 'c' })).tracks, [], 'empty playlist terminates');

    mode = 'endless'; breaker.reset();
    const capped = await qq.getPlaylist('1', { cookie: 'c', pageSize: 1000, maxSongs: 3000 });
    assert.strictEqual(capped.tracks.length, 3000, 'paging is bounded by maxSongs');

    mode = 'lyric503'; breaker.reset();
    await assert.rejects(() => qq.getLyric('mid'), (e) => e.code === 'SOURCE_HTTP_ERROR',
      'a lyric outage is distinguishable from a song that has no lyrics');
    mode = 'lyricempty'; breaker.reset();
    assert.strictEqual((await qq.getLyric('mid')).lyric, null, 'no lyrics is not a failure');

    // --- a burst must not all reach the platform --------------------------
    // Several users pressing play at once used to send every request straight
    // through: the breaker opened only after all of them had been sent, which
    // is the traffic shape that gets an IP throttled in the first place.
    mode = 'rate'; breaker.reset(); stubHits = 0;
    const burst = await Promise.allSettled(
      Array.from({ length: 20 }, () => qq.resolveUrl('mid', CRED)),
    );
    assert.ok(stubHits <= breaker.DEFAULTS.maxInFlight + 1,
      `a 20-way burst reached the platform ${stubHits} times, expected ~${breaker.DEFAULTS.maxInFlight}`);
    assert.ok(burst.some((r) => r.status === 'rejected' && r.reason.code === 'SOURCE_BUSY'),
      'excess callers are turned away locally rather than on the wire');
    assert.strictEqual(breaker.status('qq').inFlight, 0, 'every slot was released');

    // Slots must come back on the success path too, or the feature would seize
    // up after maxInFlight successful plays.
    mode = 'resolveok'; breaker.reset();
    for (let i = 0; i < 5; i += 1) await qq.resolveUrl('mid', CRED);
    assert.strictEqual(breaker.status('qq').inFlight, 0, 'slots released after successes');

    // --- a socket that dies mid-body ---------------------------------------
    // The failure arrives on the response, not the request. Unhandled, the
    // promise never settles and the caller keeps its breaker slot forever.
    mode = 'killmid'; breaker.reset();
    const started = Date.now();
    await assert.rejects(() => qq.resolveUrl('mid', CRED), () => true,
      'a truncated response settles instead of hanging');
    assert.ok(Date.now() - started < 5000, 'settles immediately, not after the 12s timeout');
    assert.strictEqual(breaker.status('qq').inFlight, 0, 'slot released after a dead socket');
  } finally {
    https.request = realRequest;
    srv.close();
    breaker.reset();
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
