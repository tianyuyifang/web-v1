/**
 * What the singers' browsers found when they asked QQ for a play URL
 * themselves, next to what the server path cost them on the same device.
 *
 * This is the evidence the switch in 档位设置 is decided on: whether asking QQ
 * from the singer's own address is at least as fast as going through this
 * server, and gives the same answer. Each sample is one card opened (or one
 * quality / vocals change), reported by the page in batches.
 *
 * Kept in memory for the admin page (last 48 hours, bounded) and written to
 * the log as one line per sample, so a week of shadow running can be read
 * back in full after a restart has cleared the memory.
 */

const KEEP_MS = 48 * 3600 * 1000;
const MAX_SAMPLES = 20000;

/** { at, mode, ...sample } oldest first. */
let samples = [];

const MODES = new Set(['shadow', 'browser']);
const REASONS = new Set([
  'ok', 'timeout', 'script-error', 'bad-response', 'credential-expired',
  'unavailable', 'no-vocals', 'no-cdn', 'skipped', 'unplayable',
]);
const WINNERS = new Set(['direct', 'server', 'cache', 'none']);
const TIERS = new Set(['flac', 'mp3_320', 'mp3_128', 'm4a']);

const ms = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 120000 ? Math.round(v) : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const pick = (v, set) => (typeof v === 'string' && set.has(v) ? v : null);

/** One reported sample, reduced to known fields and sane values. Null if unusable. */
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = pick(raw.mode, MODES);
  if (!mode) return null;
  return {
    mode,
    tier: pick(raw.tier, TIERS),
    vocals: bool(raw.vocals),
    // The browser's own attempt.
    directReason: pick(raw.directReason, REASONS),
    directMs: ms(raw.directMs),
    directTier: pick(raw.directTier, TIERS),
    directVocals: bool(raw.directVocals),
    // The server path, timed on the same device (absent when it was not asked).
    serverMs: ms(raw.serverMs),
    serverOk: bool(raw.serverOk),
    serverTier: pick(raw.serverTier, TIERS),
    serverVocals: bool(raw.serverVocals),
    // browser mode: which answer played, and whether the server was also asked.
    winner: pick(raw.winner, WINNERS),
    hedged: bool(raw.hedged),
    // Both answered: did they pick the same file?
    match: bool(raw.match),
    // How long the singer waited for an address in total (browser mode).
    waitMs: ms(raw.waitMs),
    // shadow: did the first bytes of the browser's URL actually download, and
    // from which CDN host -- the address alone does not prove it plays.
    directPlayable: bool(raw.directPlayable),
    directHost: typeof raw.directHost === 'string' && /^[a-z0-9.-]{1,80}$/i.test(raw.directHost) ? raw.directHost : null,
    // browser: a URL from QQ that the player could not play, replaced by the server's.
    playFailed: bool(raw.playFailed),
    // why the browser was not tried at all (browser mode): page / device
    // choice, or an iPhone-family element that has not played yet.
    skippedFor: pick(raw.skippedFor, new Set(['page', 'device', 'gesture'])),
    // a device that goes to the server re-timing QQ now and then (kept out of
    // the shadow figures, which would otherwise lean toward slow devices).
    reprobe: bool(raw.reprobe),
    calls: Math.max(0, Math.min(5, Math.floor(Number(raw.calls) || 0))),
  };
}

function prune(now) {
  const oldest = now - KEEP_MS;
  let i = 0;
  while (i < samples.length && samples[i].at < oldest) i += 1;
  if (i) samples = samples.slice(i);
  if (samples.length > MAX_SAMPLES) samples = samples.slice(samples.length - MAX_SAMPLES);
}

/**
 * Store a batch from one page. Returns how many were kept and how many QQ calls
 * they say the browser made (for the user-IP meter). Never throws.
 */
function record(batch, { username = null, ua = '' } = {}, now = Date.now()) {
  let kept = 0;
  let calls = 0;
  try {
    const list = Array.isArray(batch) ? batch.slice(0, 20) : [];
    for (const raw of list) {
      const s = clean(raw);
      if (!s) continue;
      samples.push({ at: now, ...s });
      kept += 1;
      calls += s.calls;
      console.log('[qqdirect] ' + JSON.stringify({ user: username, ...s, ua: String(ua).slice(0, 160) }));
    }
    prune(now);
  } catch {
    /* evidence only; never fails the request */
  }
  return { kept, calls };
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function dist(values) {
  const v = values.filter((x) => x !== null).sort((a, b) => a - b);
  return { n: v.length, p50: pct(v, 0.5), p90: pct(v, 0.9), p99: pct(v, 0.99) };
}

function countBy(list, key) {
  const out = {};
  for (const s of list) {
    const k = s[key] === null || s[key] === undefined ? 'null' : String(s[key]);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** The numbers for the admin page, over the last `hours` hours. */
function summary(hours = 24, now = Date.now()) {
  prune(now);
  const since = now - hours * 3600 * 1000;
  const list = samples.filter((s) => s.at >= since);
  const shadow = list.filter((s) => s.mode === 'shadow' && s.reprobe !== true);
  const reprobes = list.filter((s) => s.mode === 'shadow' && s.reprobe === true);
  // A play failure is reported as a second sample for the same tap (the
  // server's replacement); counted on its own, not as another tap.
  const browserAll = list.filter((s) => s.mode === 'browser');
  const browser = browserAll.filter((s) => s.playFailed !== true);
  const compared = shadow.filter((s) => s.match !== null);
  return {
    hours,
    total: list.length,
    shadow: {
      n: shadow.length,
      // Only successful direct answers are timed against the server: a fast
      // failure is not a fast answer.
      directMs: dist(shadow.filter((s) => s.directReason === 'ok').map((s) => s.directMs)),
      serverMs: dist(shadow.map((s) => s.serverMs)),
      directReasons: countBy(shadow, 'directReason'),
      compared: compared.length,
      mismatches: compared.filter((s) => s.match === false).length,
      // Of the browser's URLs that were download-checked, how many served audio.
      playableChecked: shadow.filter((s) => s.directPlayable !== null).length,
      notPlayable: shadow.filter((s) => s.directPlayable === false).length,
      hosts: countBy(shadow.filter((s) => s.directHost), 'directHost'),
    },
    browser: {
      n: browser.length,
      waitMs: dist(browser.map((s) => s.waitMs)),
      winners: countBy(browser, 'winner'),
      hedged: browser.filter((s) => s.hedged === true).length,
      directReasons: countBy(browser, 'directReason'),
      playFailed: browserAll.filter((s) => s.playFailed === true).length,
      skippedFor: countBy(browser.filter((s) => s.skippedFor), 'skippedFor'),
      reprobes: reprobes.length,
    },
  };
}

/** For tests. */
function reset() {
  samples = [];
}

module.exports = { record, summary, reset, clean };
