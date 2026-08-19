/**
 * The NetEase source must go through the circuit breaker.
 *
 * NetEase blocks by IP, and every user's lookups leave from one server
 * address, so an unprotected retry path takes the feature down for everyone.
 * Run: node tests/netease-breaker-test.js
 */
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const breaker = require('../src/services/musicSourceBreaker');

const PLATFORM = 'netease';

// --- the block code must be recognised as rate limiting ---
// -460 "Cheating" is NetEase's IP-reputation block on the playback-URL
// endpoint. It arrives as a 200 with the code in the body.
assert.strictEqual(breaker.isRateLimit(-460), true, '-460 must count as rate limiting');
assert.strictEqual(breaker.isRateLimit(104604), true, "QQ's code still counts");
// A paid track is a permission answer, not throttling. Tripping on these would
// disable playback over ordinary missing songs.
assert.strictEqual(breaker.isRateLimit(301), false, 'expired credential is not throttling');
assert.strictEqual(breaker.isRateLimit(200), false, 'success is not throttling');
assert.strictEqual(breaker.isRateLimit(null), false);

// --- every outbound NetEase call must be wrapped ---
const src = fs.readFileSync(require.resolve('../src/services/sources/neteaseLogin'), 'utf8');
assert.ok(/breaker\.acquire\(/.test(src), 'must claim an in-flight slot');
assert.ok(/breaker\.release\(/.test(src), 'must release it in a finally');
assert.ok(/breaker\.recordFailure\(/.test(src), 'must report throttling to the breaker');
// Only the wrapper may issue requests; a second raw path would bypass it.
assert.strictEqual((src.match(/https\.request\(/g) || []).length, 2,
  'exactly two request sites: the eapi wrapper and the CORS probe');

// --- three blocks in a row must open the breaker ---
breaker.reset(PLATFORM);
assert.strictEqual(breaker.recordFailure(PLATFORM, -460), false, 'one is noise');
assert.strictEqual(breaker.recordFailure(PLATFORM, -460), false, 'two is noise');
assert.strictEqual(breaker.recordFailure(PLATFORM, -460), true, 'three opens it');

// --- and while open, further calls must be refused rather than sent ---
assert.throws(
  () => breaker.acquire(PLATFORM),
  (err) => err.code === 'SOURCE_UNAVAILABLE' && err.status === 503,
  'CRITICAL: an open breaker must stop traffic, not merely report it'
);

// --- a success clears the count, so isolated failures never accumulate ---
breaker.reset(PLATFORM);
breaker.recordFailure(PLATFORM, -460);
breaker.recordFailure(PLATFORM, -460);
breaker.recordSuccess(PLATFORM);
assert.strictEqual(breaker.recordFailure(PLATFORM, -460), false,
  'a success between failures must reset the streak');

// --- the wrapper must actually route a -460 body into the breaker ---
// Stub the transport so this exercises the real wrapper without a network
// call: NetEase is a live service and a test must never send traffic to it.
breaker.reset(PLATFORM);
const realRequest = require('https').request;
require('https').request = function stub(_opts, cb) {
  const res = new (require('stream').PassThrough)();
  res.headers = {};
  process.nextTick(() => {
    cb(res);
    res.end(JSON.stringify({ code: -460, msg: 'Cheating' }));
  });
  return { on() {}, setTimeout() {}, write() {}, end() {}, destroy() {} };
};

(async () => {
  try {
    // Fresh copy so the stub is in place for its transport.
    delete require.cache[require.resolve('../src/services/sources/neteaseLogin')];
    const netease = require('../src/services/sources/neteaseLogin');

    let threw = null;
    try {
      await netease.getAccountInfo('fake=cookie');
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'a -460 body must surface as an error');
    assert.strictEqual(threw.code, 'SOURCE_RATE_LIMITED',
      'CRITICAL: -460 must be reported as throttling, not as a missing track');
    assert.strictEqual(threw.platformCode, -460);

    const st = breaker.status ? breaker.status(PLATFORM) : null;
    if (st) assert.ok(st.failures >= 1, 'the failure reached the breaker');

    console.log('netease-breaker tests passed');
  } finally {
    require('https').request = realRequest;
    delete require.cache[require.resolve('../src/services/sources/neteaseLogin')];
    breaker.reset(PLATFORM);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
