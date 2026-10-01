/**
 * How much this server is saying to the music platforms, counted at the
 * point of leaving.
 *
 * Every other protection here reacts to a refusal: the breaker waits for a
 * rate-limit code, the pacer only spreads calls out. Nothing watched the total
 * — and the total is what an address is judged by. This counts every outbound
 * call per platform and per kind (read / write / lyric / login / probe), per
 * minute and per UTC day, and says so in the log once a minute crosses its
 * threshold. The admin page shows the same numbers.
 *
 * The kinds are separated because they are judged differently: a lyric call
 * carries no credential and is attributable only to this address; a write
 * changes a user's account; a read is the bulk; login is signing in and
 * renewing (QR codes, scan polling, key renewal); probe is NetEase's check of
 * whether a CDN lets the browser play directly. In memory, per process — the
 * backend is one process, and a restart losing a day's tally is acceptable.
 *
 * Separately, calls the singer's own browser made to a platform (reported by
 * the page, see qqDirect): those leave from the singer's address, not this
 * one, and are kept apart so the two can be compared, not added up.
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

const KINDS = Object.freeze(['read', 'write', 'lyric', 'login', 'probe']);

/** platform → { minutes: Map<minuteKey, bucket>, days: Map<dayKey, bucket>, lastWarnMinute } */
const state = new Map();
/** The same, for calls made from users' own browsers; a bucket there is { calls }. */
const userState = new Map();

function bucket() {
  return { read: 0, write: 0, lyric: 0, login: 0, probe: 0 };
}

function entry(platform, map = state) {
  let s = map.get(platform);
  if (!s) {
    s = { minutes: new Map(), days: new Map(), lastWarnMinute: null };
    map.set(platform, s);
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
  return KINDS.reduce((n, k) => n + b[k], 0);
}

/**
 * One outbound call is leaving. `kind` is one of KINDS; anything else counts
 * as a read. Returns nothing and never throws: metering must not be able to
 * fail a call.
 */
function record(platform, kind, now = Date.now()) {
  try {
    const s = entry(platform);
    const k = KINDS.includes(kind) ? kind : 'read';
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
      console.warn(`[outbound] ${platform} ${total(m)} calls this minute (limit ${limit}): ${KINDS.map((x) => `${x} ${m[x]}`).join(', ')}`);
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
      for (const k of KINDS) hour[k] += b[k];
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

/**
 * `n` calls a user's browser made to a platform itself, as the page reported
 * them. Never throws. Capped per report so one page cannot inflate the count.
 */
function recordUserIp(platform, n, now = Date.now()) {
  try {
    const add = Math.max(0, Math.min(200, Math.floor(Number(n) || 0)));
    if (!add || !THRESHOLDS[platform]) return;
    const s = entry(platform, userState);
    const mk = minuteKey(now);
    const dk = dayKey(now);
    if (!s.minutes.has(mk)) s.minutes.set(mk, { calls: 0 });
    if (!s.days.has(dk)) s.days.set(dk, { calls: 0 });
    s.minutes.get(mk).calls += add;
    s.days.get(dk).calls += add;
    if (s.minutes.size > KEEP_MINUTES + 1) sweep(s, now);
  } catch {
    /* metering only */
  }
}

/** Users' own-browser calls, per platform: this minute, last hour, today, yesterday. */
function userIpSnapshot(now = Date.now()) {
  const out = {};
  for (const platform of Object.keys(THRESHOLDS)) {
    const s = entry(platform, userState);
    sweep(s, now);
    const mk = minuteKey(now);
    let hour = 0;
    for (let i = KEEP_MINUTES - 1; i >= 0; i -= 1) hour += (s.minutes.get(mk - i) || { calls: 0 }).calls;
    out[platform] = {
      thisMinute: (s.minutes.get(mk) || { calls: 0 }).calls,
      lastHour: hour,
      today: (s.days.get(dayKey(now)) || { calls: 0 }).calls,
      yesterday: (s.days.get(dayKey(now - 86400000)) || { calls: 0 }).calls,
    };
  }
  return out;
}

/** For tests. */
function reset() {
  state.clear();
  userState.clear();
}

module.exports = {
  record, snapshot, reset, recordUserIp, userIpSnapshot, THRESHOLDS, KINDS,
};
