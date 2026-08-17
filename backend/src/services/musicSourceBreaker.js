/**
 * Circuit breaker for outbound calls to QQ / NetEase.
 *
 * These platforms rate-limit by IP, not by account: during development a burst
 * of parameter-guessing got this machine's vkey access cut off for hours, and
 * an anonymous request with no credentials at all came back with the same
 * error. Every user's lookups leave from one server address, so a retry loop
 * does not degrade one person's playback — it takes the feature down for
 * everybody, and keeps it down long after the traffic stops.
 *
 * So the rule is inverted from the usual one: when the platform signals it has
 * had enough, stop completely for a while. Retrying is what turns "a few bad
 * requests" into "blocked for hours".
 *
 * Per platform, in memory. A restart clears it, which is acceptable — the
 * window is minutes and a restart is not how you get rate limited.
 */

/**
 * Codes that mean "you are being throttled" and nothing else.
 *
 * Kept deliberately narrow. `104009` used to be in here on the belief that it
 * signalled an IP block; it does not — it is what the retired
 * `vkey.GetVkeyServer` endpoint returns for everyone, from any address, and
 * treating it as throttling meant a dead endpoint could shut the feature down
 * for fifteen minutes at a time. A code earns a place here only once it is
 * confirmed to be about rate, not about the request being wrong.
 */
const RATE_LIMIT_CODES = new Set([
  104604, // QQ: "操作过于频繁" — the platform's own rate-limit code.
]);

const DEFAULTS = {
  // Three strikes. One failure is noise (a delisted track, a flaky response);
  // three in a row is the platform talking to us.
  threshold: 3,
  // Long enough to actually clear, short enough that a false trip costs one
  // song rather than an evening. The observed block outlasted this by a lot,
  // so this is a courtesy pause, not a countdown to recovery.
  cooldownMs: 15 * 60 * 1000,
  // Consecutive failures only count while they are recent. A failure this
  // morning and two tonight is not a pattern.
  windowMs: 5 * 60 * 1000,
  // Ceiling on requests in flight at once, per platform.
  //
  // The breaker alone cannot stop a burst: twenty callers all pass the
  // is-it-open check before the first reply comes back, so all twenty reach
  // the platform and the breaker opens only afterwards. A sudden burst is
  // precisely the traffic shape that gets an IP throttled — the block during
  // development came from exactly this, not from steady traffic. Capping
  // concurrency means at most this many requests can be wrong before the
  // breaker has its say.
  //
  // Two is ample: the feature resolves a URL when someone presses play, and
  // the expected rate is a handful of songs per minute.
  maxInFlight: 2,
};

const state = new Map(); // platform -> { failures, firstFailureAt, openedAt, inFlight, halfOpenAt, probeInFlight }

function entry(platform) {
  let s = state.get(platform);
  if (!s) {
    s = { failures: 0, firstFailureAt: 0, openedAt: 0, inFlight: 0, halfOpenAt: 0, probeInFlight: false };
    state.set(platform, s);
  }
  return s;
}

/** Is this error the platform telling us to back off? */
function isRateLimit(codeOrError) {
  if (codeOrError == null) return false;
  const code = typeof codeOrError === 'object'
    ? (codeOrError.platformCode ?? codeOrError.code)
    : codeOrError;
  return RATE_LIMIT_CODES.has(Number(code));
}

/**
 * Throws when the breaker is open. Call before every outbound request.
 *
 * Deliberately throws rather than returning false: a caller that forgets to
 * check a boolean would sail straight through into the request, which is the
 * exact failure this module exists to prevent.
 */
function assertClosed(platform, now = Date.now()) {
  const s = entry(platform);
  if (!s.openedAt) return;

  const remainingMs = s.openedAt + DEFAULTS.cooldownMs - now;
  if (remainingMs <= 0) {
    // Cooldown served — but going straight back to full traffic is the
    // thundering herd: the platform may well still be blocking us, and a wave
    // of requests is what caused the block in the first place. So enter
    // half-open and let exactly one request through to find out.
    //
    // Deliberately no retry loop anywhere in this module. Whoever gets the
    // probe either succeeds (breaker closes) or fails (cooldown restarts);
    // nobody retries on their behalf.
    if (!s.halfOpenAt) {
      s.halfOpenAt = now;
      s.probeInFlight = true;
      s.openedAt = 0;
      s.failures = 0;
      s.firstFailureAt = 0;
      return; // this caller is the probe
    }
    return;
  }

  const err = new Error(`${platform} 音源暂时不可用，请稍后再试`);
  err.code = 'SOURCE_UNAVAILABLE';
  err.platform = platform;
  err.retryAfterMs = remainingMs;
  err.status = 503;
  throw err;
}

/**
 * Claim one of the in-flight slots, or throw.
 *
 * Paired with release() in a finally block. Without the cap, a burst of
 * callers all clear assertClosed() before any of them hears back, so the
 * breaker learns about the problem only once every one of those requests has
 * already been sent.
 */
function acquire(platform, now = Date.now()) {
  assertClosed(platform, now);
  const s = entry(platform);

  // Half-open: one probe is already out. Everyone else waits rather than
  // piling onto a platform that has not proven it is serving us again.
  if (s.halfOpenAt && !s.probeInFlight) {
    const err = new Error(`${platform} 音源正在恢复中，请稍后再试`);
    err.code = 'SOURCE_RECOVERING';
    err.platform = platform;
    err.status = 503;
    throw err;
  }
  if (s.halfOpenAt && s.probeInFlight) {
    // This caller IS the probe; claim it so the next one is turned away.
    s.probeInFlight = false;
    s.inFlight += 1;
    return;
  }

  if (s.inFlight >= DEFAULTS.maxInFlight) {
    const err = new Error(`${platform} 音源正忙，请稍后再试`);
    err.code = 'SOURCE_BUSY';
    err.platform = platform;
    err.status = 503;
    throw err;
  }
  s.inFlight += 1;
}

/** Release a slot claimed by acquire(). Safe to call more than once. */
function release(platform) {
  const s = entry(platform);
  if (s.inFlight > 0) s.inFlight -= 1;
}

/** Report a successful call. Clears any partial failure streak. */
function recordSuccess(platform) {
  const s = entry(platform);
  s.failures = 0;
  s.firstFailureAt = 0;
  // The probe came back clean: the platform is serving us again, so leave
  // half-open and resume normal traffic.
  s.halfOpenAt = 0;
  s.probeInFlight = false;
}

/**
 * Report a failure. Only rate-limit signals count toward opening the breaker:
 * a track that needs VIP, or one that has been delisted, says nothing about
 * whether we are being throttled, and tripping on those would disable the
 * feature over ordinary missing songs.
 *
 * Returns true if this failure opened the breaker.
 */
function recordFailure(platform, codeOrError, now = Date.now()) {
  if (!isRateLimit(codeOrError)) return false;

  const s = entry(platform);
  if (s.openedAt) return false; // already open, nothing to escalate

  // The probe failed: the platform is still refusing us. Go straight back to
  // open for another full cooldown — no second chance, no counting up to
  // three again, because we already know the answer.
  if (s.halfOpenAt) {
    s.halfOpenAt = 0;
    s.probeInFlight = false;
    s.openedAt = now;
    s.failures = DEFAULTS.threshold;
    return true;
  }

  if (!s.failures || now - s.firstFailureAt > DEFAULTS.windowMs) {
    s.failures = 1;
    s.firstFailureAt = now;
  } else {
    s.failures += 1;
  }

  if (s.failures >= DEFAULTS.threshold) {
    s.openedAt = now;
    return true;
  }
  return false;
}

/** Current state, for the admin page and for tests. */
function status(platform, now = Date.now()) {
  const s = entry(platform);
  const open = Boolean(s.openedAt) && s.openedAt + DEFAULTS.cooldownMs > now;
  return {
    platform,
    open,
    failures: s.failures,
    inFlight: s.inFlight,
    halfOpen: Boolean(s.halfOpenAt),
    retryAfterMs: open ? s.openedAt + DEFAULTS.cooldownMs - now : 0,
  };
}

/** Test hook. Never call from request paths. */
function reset(platform) {
  if (platform) state.delete(platform);
  else state.clear();
}

module.exports = {
  assertClosed,
  acquire,
  release,
  recordSuccess,
  recordFailure,
  isRateLimit,
  status,
  reset,
  RATE_LIMIT_CODES,
  DEFAULTS,
};
