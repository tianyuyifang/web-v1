/**
 * How much this server is saying to the music platforms, counted at the
 * point of leaving.
 *
 * Every other protection here reacts to a refusal: the breaker waits for a
 * rate-limit code, the pacer only spreads calls out. Nothing watched the total
 * — and the total is what an address is judged by. This counts every outbound
 * call per platform and per kind (read / write / lyric), per minute and per
 * UTC day, and says so in the log once a minute crosses its threshold. The
 * admin page shows the same numbers.
 *
 * The kinds are separated because they are judged differently: a lyric call
 * carries no credential and is attributable only to this address; a write
 * changes a user's account; a read is the bulk. In memory, per process — the
 * backend is one process, and a restart losing a day's tally is acceptable.
 *
 * Thresholds are the measured baseline with room: the 22-day peak was 19
 * calls a minute across every kind (2026-09-27), so 300 a minute is not a
 * busy evening, it is a loop or a script.
 */
const THRESHOLDS = Object.freeze({
  qq: { minute: 300 },
  netease: { minute: 100 },
});

const KEEP_MINUTES = 60; // enough for the admin page to draw the last hour

/** platform → { minutes: Map<minuteKey, {read,write,lyric}>, days: Map<dayKey, {...}>, lastWarnMinute } */
const state = new Map();

function bucket() {
  return { read: 0, write: 0, lyric: 0 };
}

function entry(platform) {
  let s = state.get(platform);
  if (!s) {
    s = { minutes: new Map(), days: new Map(), lastWarnMinute: null };
    state.set(platform, s);
  }
  return s;
}

function minuteKey(now) {
  return Math.floor(now / 60000);
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Drop minutes past the window and days other than today and yesterday. */
function sweep(s, now) {
  const oldest = minuteKey(now) - KEEP_MINUTES;
  for (const k of s.minutes.keys()) if (k < oldest) s.minutes.delete(k);
  const today = dayKey(now);
  const yesterday = dayKey(now - 86400000);
  for (const k of s.days.keys()) if (k !== today && k !== yesterday) s.days.delete(k);
}

function total(b) {
  return b.read + b.write + b.lyric;
}

/**
 * One outbound call is leaving. `kind` is 'read' | 'write' | 'lyric'.
 * Returns nothing and never throws: metering must not be able to fail a call.
 */
function record(platform, kind, now = Date.now()) {
  try {
    const s = entry(platform);
    const k = kind === 'write' || kind === 'lyric' ? kind : 'read';
    const mk = minuteKey(now);
    const dk = dayKey(now);
    if (!s.minutes.has(mk)) s.minutes.set(mk, bucket());
    if (!s.days.has(dk)) s.days.set(dk, bucket());
    s.minutes.get(mk)[k] += 1;
    s.days.get(dk)[k] += 1;
    if (s.minutes.size > KEEP_MINUTES + 1) sweep(s, now);

    const limit = THRESHOLDS[platform]?.minute;
    const m = s.minutes.get(mk);
    if (limit && total(m) > limit && s.lastWarnMinute !== mk) {
      // Once per minute, at the moment of crossing: the number that follows
      // says how far over, and the breakdown says which kind is doing it.
      s.lastWarnMinute = mk;
      console.warn(`[outbound] ${platform} ${total(m)} calls this minute (limit ${limit}): read ${m.read}, write ${m.write}, lyric ${m.lyric}`);
    }
  } catch {
    /* metering only */
  }
}

/** The numbers, for the admin page: this minute, last hour, today, yesterday. */
function snapshot(now = Date.now()) {
  const out = {};
  for (const platform of Object.keys(THRESHOLDS)) {
    const s = entry(platform);
    sweep(s, now);
    const mk = minuteKey(now);
    const thisMinute = s.minutes.get(mk) || bucket();
    const hour = bucket();
    const recent = [];
    for (let i = KEEP_MINUTES - 1; i >= 0; i -= 1) {
      const b = s.minutes.get(mk - i) || bucket();
      hour.read += b.read; hour.write += b.write; hour.lyric += b.lyric;
      recent.push(total(b));
    }
    out[platform] = {
      limitPerMinute: THRESHOLDS[platform].minute,
      thisMinute,
      lastHour: hour,
      today: s.days.get(dayKey(now)) || bucket(),
      yesterday: s.days.get(dayKey(now - 86400000)) || bucket(),
      // Per-minute totals for the last hour, oldest first, for a sparkline.
      recentMinutes: recent,
    };
  }
  return out;
}

/** For tests. */
function reset() {
  state.clear();
}

module.exports = { record, snapshot, reset, THRESHOLDS };
