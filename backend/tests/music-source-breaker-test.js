/**
 * musicSourceBreaker tests — pure, no DB and no network.
 * Run: node tests/music-source-breaker-test.js
 *
 * This module exists because retrying against a rate limit is what turns a few
 * bad requests into hours of downtime for every user at once. The cases below
 * are the ones that actually matter: that ordinary failures do NOT trip it,
 * that rate-limit signals do, and that it reopens cleanly afterwards.
 */
const assert = require('assert');
const b = require('../src/services/musicSourceBreaker');

const T0 = 1_700_000_000_000; // fixed clock; never Date.now() in assertions

// --- only rate-limit signals count -----------------------------------------
assert.strictEqual(b.isRateLimit(104604), true, 'QQ \"操作过于频繁\"');
// 104009 was in this set on the belief that it meant an IP block. It does not:
// it is what the retired vkey.GetVkeyServer endpoint returns for everyone, from
// any address. Treating it as throttling let a dead endpoint shut the feature
// down for fifteen minutes at a time.
assert.strictEqual(b.isRateLimit(104009), false, 'a dead endpoint is not a rate limit');
assert.strictEqual(b.isRateLimit({ platformCode: 104604 }), true, 'reads platformCode off an error');
assert.strictEqual(b.isRateLimit(0), false, 'success is not a rate limit');
assert.strictEqual(b.isRateLimit(null), false);
assert.strictEqual(b.isRateLimit(undefined), false);
// A VIP-only or delisted track says nothing about throttling. Tripping on
// these would disable the feature over ordinary missing songs.
assert.strictEqual(b.isRateLimit(404), false, 'delisted/needs-VIP must not trip it');

// --- ordinary failures never open it ---------------------------------------
b.reset();
for (let i = 0; i < 20; i += 1) b.recordFailure('qq', 404, T0 + i);
assert.strictEqual(b.status('qq', T0).open, false, '20 non-rate-limit failures leave it closed');
assert.doesNotThrow(() => b.assertClosed('qq', T0));

// --- three consecutive rate limits open it ---------------------------------
b.reset();
assert.strictEqual(b.recordFailure('qq', 104604, T0), false, '1st does not open');
assert.strictEqual(b.recordFailure('qq', 104604, T0 + 1000), false, '2nd does not open');
assert.strictEqual(b.recordFailure('qq', 104604, T0 + 2000), true, '3rd opens it');
assert.strictEqual(b.status('qq', T0 + 2000).open, true);

// Open means calls stop, and the caller is told for how long.
let err = null;
try { b.assertClosed('qq', T0 + 2000); } catch (e) { err = e; }
assert.ok(err, 'assertClosed throws while open');
assert.strictEqual(err.code, 'SOURCE_UNAVAILABLE');
assert.strictEqual(err.status, 503, 'surfaces as a 503, not a generic 500');
assert.ok(err.retryAfterMs > 0, 'tells the caller how long to wait');
assert.strictEqual(err.platform, 'qq', 'names the platform that is down');

// --- one platform failing must not disable the other -----------------------
// They are independent services; a QQ block says nothing about NetEase.
assert.doesNotThrow(() => b.assertClosed('netease', T0 + 2000), 'netease unaffected');

// --- success clears a partial streak ---------------------------------------
b.reset();
b.recordFailure('qq', 104604, T0);
b.recordFailure('qq', 104604, T0 + 100);
b.recordSuccess('qq');
assert.strictEqual(b.recordFailure('qq', 104604, T0 + 200), false,
  'streak restarted, so this is a 1st failure and not a 3rd');
assert.strictEqual(b.status('qq', T0 + 200).open, false);

// --- stale failures do not accumulate --------------------------------------
// A failure this morning and two tonight is not a pattern.
b.reset();
const beyondWindow = b.DEFAULTS.windowMs + 1000;
b.recordFailure('qq', 104604, T0);
b.recordFailure('qq', 104604, T0 + beyondWindow);
b.recordFailure('qq', 104604, T0 + beyondWindow + 100);
assert.strictEqual(b.status('qq', T0 + beyondWindow + 100).open, false,
  'the first failure aged out, so only two are current');

// --- cooldown expiry -------------------------------------------------------
// The cooldown runs from the moment it opened — the third failure — not from
// the first one in the streak.
b.reset();
b.recordFailure('qq', 104604, T0);
b.recordFailure('qq', 104604, T0 + 1);
const openedAt = T0 + 2;
b.recordFailure('qq', 104604, openedAt);

const justBefore = openedAt + b.DEFAULTS.cooldownMs - 1;
assert.throws(() => b.assertClosed('qq', justBefore), 'still open one ms early');
assert.strictEqual(b.status('qq', justBefore).retryAfterMs, 1, 'one ms left to serve');

const justAfter = openedAt + b.DEFAULTS.cooldownMs + 1;
assert.doesNotThrow(() => b.assertClosed('qq', justAfter), 'stops blocking once served');
// It does not reopen to full traffic though — it enters half-open, so the
// first failure after the cooldown reopens immediately rather than starting a
// fresh count of three. We already know the platform is refusing us; making
// two more requests to confirm is exactly the traffic we are avoiding.
assert.strictEqual(b.status('qq', justAfter).halfOpen, true, 'cooldown leads to half-open');
assert.strictEqual(b.recordFailure('qq', 104604, justAfter + 1), true,
  'a failed probe reopens on the spot');

// --- an open breaker does not re-arm itself --------------------------------
b.reset();
b.recordFailure('qq', 104604, T0);
b.recordFailure('qq', 104604, T0 + 1);
assert.strictEqual(b.recordFailure('qq', 104604, T0 + 2), true, 'opens');
assert.strictEqual(b.recordFailure('qq', 104604, T0 + 3), false,
  'further failures while open do not extend or re-trip it');

// --- in-flight cap ----------------------------------------------------------
// The breaker alone cannot stop a burst: every caller passes the is-it-open
// check before the first reply arrives, so all of them reach the platform and
// the breaker opens only afterwards. A burst is exactly the shape that gets an
// IP throttled, so concurrency is capped as well.
b.reset();
for (let i = 0; i < b.DEFAULTS.maxInFlight; i += 1) b.acquire('qq', T0);
assert.strictEqual(b.status('qq', T0).inFlight, b.DEFAULTS.maxInFlight, 'slots claimed');

let busy = null;
try { b.acquire('qq', T0); } catch (e) { busy = e; }
assert.ok(busy, 'acquire throws once the slots are taken');
assert.strictEqual(busy.code, 'SOURCE_BUSY');
assert.strictEqual(busy.status, 503);

b.release('qq');
assert.doesNotThrow(() => b.acquire('qq', T0), 'a released slot can be reclaimed');

// release() must not drive the count negative, or a stray extra call would
// silently raise the ceiling for everyone afterwards.
b.reset();
b.release('qq'); b.release('qq');
assert.strictEqual(b.status('qq', T0).inFlight, 0, 'release floors at zero');

// An open breaker rejects before any slot is handed out — otherwise slots
// would leak on a path that never reaches a release().
b.reset();
for (let i = 0; i < 3; i += 1) b.recordFailure('qq', 104604, T0 + i);
let blocked = null;
try { b.acquire('qq', T0 + 3); } catch (e) { blocked = e; }
assert.strictEqual(blocked && blocked.code, 'SOURCE_UNAVAILABLE', 'open breaker wins over the slot check');
assert.strictEqual(b.status('qq', T0 + 3).inFlight, 0, 'no slot leaked on the rejected path');

// Platforms hold separate slot pools; QQ being busy must not block NetEase.
b.reset();
for (let i = 0; i < b.DEFAULTS.maxInFlight; i += 1) b.acquire('qq', T0);
assert.doesNotThrow(() => b.acquire('netease', T0), 'slot pools are per platform');

// --- half-open probe --------------------------------------------------------
// Reopening the gates all at once when the cooldown expires is the thundering
// herd: the platform may still be blocking us, and a wave of traffic is what
// caused the block. So one request goes first to find out.
const tripped = () => {
  b.reset();
  for (let i = 0; i < 3; i += 1) b.recordFailure('qq', 104604, T0 + i);
  return T0 + 2 + b.DEFAULTS.cooldownMs + 1;
};

let after = tripped();
let admitted = 0;
let recovering = 0;
for (let i = 0; i < 10; i += 1) {
  try { b.acquire('qq', after); admitted += 1; } catch (e) {
    if (e.code === 'SOURCE_RECOVERING') recovering += 1;
  }
}
assert.strictEqual(admitted, 1, 'exactly one probe is admitted');
assert.strictEqual(recovering, 9, 'everyone else waits');
assert.strictEqual(b.status('qq', after).halfOpen, true);

// Probe succeeds: normal service resumes.
b.release('qq');
b.recordSuccess('qq');
assert.strictEqual(b.status('qq', after).halfOpen, false, 'left half-open');
let resumed = 0;
for (let i = 0; i < 5; i += 1) { try { b.acquire('qq', after); resumed += 1; } catch { /* capped */ } }
assert.strictEqual(resumed, b.DEFAULTS.maxInFlight, 'full concurrency restored');

// Probe fails: straight back to a FULL cooldown. No second chance and no
// counting to three again — we already know the platform is still refusing.
after = tripped();
b.acquire('qq', after);
b.release('qq');
assert.strictEqual(b.recordFailure('qq', 104604, after), true, 'probe failure reopens');
const reopened = b.status('qq', after);
assert.strictEqual(reopened.open, true);
assert.strictEqual(reopened.halfOpen, false);
assert.strictEqual(Math.round(reopened.retryAfterMs / 60000),
  Math.round(b.DEFAULTS.cooldownMs / 60000), 'a full cooldown, not a partial one');

b.reset();
console.log('music-source-breaker tests passed');
