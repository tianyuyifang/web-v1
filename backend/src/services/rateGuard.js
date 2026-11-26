const prisma = require('../db/client');
const { AppError } = require('../utils/errors');

/**
 * Per-account usage limits.
 *
 * Why: on 2026-11-25 one paid account walked the whole library with scripts —
 * every song's details and lyrics, 983 full songs in ten minutes. Nothing
 * counted how much one account took. This does, per kind of request, against
 * two lines:
 *
 *   first line  — past it, that kind of request is refused (429) until the
 *                 count drops back. Nothing else about the account changes.
 *                 It is the most one account can take, person or program.
 *   second line — the first line times `revokeFactor`. Refused requests still
 *                 count, so a program that keeps hammering after the first
 *                 line gets here in minutes; a person who is refused stops.
 *                 Reaching it raises an alert and, when `autoRevoke` is on,
 *                 revokes the account.
 *
 * Each line is checked over the last ten minutes and over the Beijing calendar
 * day. The numbers come from 30 days of real use — the heaviest ordinary user,
 * measured the way this file measures (any ten consecutive minutes, not clock
 * ten-minute blocks: the first set of numbers was taken from blocks, and a
 * replay of that month's requests through this code refused three real
 * people) — with some room, and are editable from the admin page.
 *
 * Counts live in this process's memory: nothing is read or written per
 * request, and a restart simply starts the day's counts again. The database is
 * touched only when a line is actually hit. Admins are not counted.
 */

/**
 * `distinct`: count different songs/clips/playlists rather than requests — one
 * song fetched in twenty ranges, or played twenty times, is one song.
 */
const CATEGORIES = Object.freeze({
  clip:         { label: '切片', distinct: true },
  song:         { label: '整首歌', distinct: true },
  detail:       { label: '歌曲详情', distinct: true },
  // Making a clip (新建切片): each one is 20 s of the song's lyrics in the
  // answer, and an ffmpeg run. noRevoke: a person cutting many clips keeps
  // pressing after a refusal.
  clipCreate:   { label: '新建切片', distinct: false, noRevoke: true },
  // The clips one song has (the player's 切换片段, and adding a song): where
  // each clip starts is in the answer.
  songClips:    { label: '查看歌曲的切片', distinct: true },
  search:       { label: '搜歌', distinct: false },
  // noRevoke: the share box asks again on every pause in typing, so a person
  // who has been refused and keeps typing would walk to the second line. It
  // still raises the alert; it never revokes.
  userSearch:   { label: '搜用户名', distinct: false, noRevoke: true },
  playlistOpen: { label: '打开歌单', distinct: true },
  fileImport:   { label: '表格导入', distinct: false, noRevoke: true },
  // The 唱卡 song search (练唱 / 标记): it pages through the mapping table.
  librarySearch: { label: '唱卡搜歌', distinct: false, noRevoke: true },
});

const SETTINGS_KEY = 'rateLimits';
const DEFAULTS = Object.freeze({
  limits: Object.freeze({
    clip:         { ten: 900, day: 5000 },
    song:         { ten: 55, day: 230 },
    detail:       { ten: 55, day: 180 },
    songClips:    { ten: 70, day: 700 },
    clipCreate:   { ten: 60, day: 250 },
    librarySearch: { ten: 130, day: 500 },
    search:       { ten: 300, day: 900 },
    userSearch:   { ten: 35, day: 60 },
    playlistOpen: { ten: 100, day: 250 },
    fileImport:   { ten: null, day: 5 },
  }),
  revokeFactor: 3,
  // Off until the alerts have been watched for a while: with it off the second
  // line only raises the alert.
  autoRevoke: false,
});

const TEN_MIN_MS = 10 * 60 * 1000;
const CONFIG_TTL_MS = 30 * 1000;
// How often a row already written for today is refreshed with the latest count.
const ALERT_REFRESH_MS = 30 * 1000;
// A person refused once and trying again a minute later is one visit to the
// line, not two: visits are told apart by a quiet gap this long.
const EPISODE_GAP_MS = TEN_MIN_MS;
const REPEAT_EPISODES = 3;

const MESSAGE = '操作太频繁，请稍后再试';

/** Beijing calendar day of a timestamp, YYYY-MM-DD. */
function beijingDay(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function cleanLimit(v, fallback) {
  if (v === null) return null;
  return Number.isInteger(v) && v >= 1 && v <= 10000000 ? v : fallback;
}

/** Stored settings laid over the defaults, every number validated. */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const limits = {};
  for (const key of Object.keys(CATEGORIES)) {
    const def = DEFAULTS.limits[key];
    const got = (src.limits && src.limits[key]) || {};
    limits[key] = {
      ten: cleanLimit(got.ten === undefined ? def.ten : got.ten, def.ten),
      day: cleanLimit(got.day === undefined ? def.day : got.day, def.day),
    };
  }
  const factor = Number(src.revokeFactor);
  return {
    limits,
    revokeFactor: Number.isFinite(factor) && factor >= 1.5 && factor <= 100 ? factor : DEFAULTS.revokeFactor,
    autoRevoke: src.autoRevoke === true,
  };
}

let config = normalize(null);
let configReadAt = 0;
let configReading = false;

/**
 * The limits in force. Never waits: the copy in memory is used, and re-read in
 * the background when it is older than CONFIG_TTL_MS, so a change on the admin
 * page reaches every request within that time and no request pays for it.
 */
function currentConfig(now) {
  if (!configReading && now - configReadAt > CONFIG_TTL_MS) {
    configReading = true;
    prisma.setting.findUnique({ where: { key: SETTINGS_KEY } })
      .then((row) => { config = normalize(row ? row.value : null); })
      .catch(() => {})
      .finally(() => { configReadAt = Date.now(); configReading = false; });
  }
  return config;
}

async function getConfig() {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  return normalize(row ? row.value : null);
}

/** A message for the first value in a patch that cannot be used, or null. */
function invalidIn(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  for (const [key, got] of Object.entries(p.limits || {})) {
    if (!CATEGORIES[key]) return `未知的项目：${key}`;
    for (const w of ['ten', 'day']) {
      if (got == null || got[w] === undefined || got[w] === null) continue;
      if (!Number.isInteger(got[w]) || got[w] < 1 || got[w] > 10000000) {
        return `${CATEGORIES[key].label}：请填 1 到 10000000 的整数，或留空表示不限`;
      }
    }
  }
  if (p.revokeFactor !== undefined) {
    const f = p.revokeFactor;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 1.5 || f > 100) return '第二道线倍数请填 1.5 到 100 之间的数';
  }
  if (p.autoRevoke !== undefined && typeof p.autoRevoke !== 'boolean') return '自动撤销开关的值不对';
  return null;
}

async function setConfig(patch) {
  const problem = invalidIn(patch);
  if (problem) throw new AppError(problem, 400);
  const before = await getConfig();
  const limits = {};
  for (const key of Object.keys(CATEGORIES)) {
    limits[key] = { ...before.limits[key], ...((patch && patch.limits && patch.limits[key]) || {}) };
  }
  const merged = normalize({
    limits,
    revokeFactor: patch && patch.revokeFactor !== undefined ? patch.revokeFactor : before.revokeFactor,
    autoRevoke: patch && patch.autoRevoke !== undefined ? patch.autoRevoke : before.autoRevoke,
  });
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: merged },
    update: { value: merged },
  });
  config = merged;
  configReadAt = Date.now();
  return merged;
}

/**
 * Accounts an admin has whitelisted (users.rate_exempt). They are counted like
 * anyone and going over a line still raises the alert — it is the person who
 * is trusted, not whoever holds the password — but nothing is refused and the
 * account is never revoked from here.
 *
 * Kept as a Set in memory, re-read in the background every EXEMPT_TTL_MS and
 * at once when an admin changes someone (refreshExempt).
 */
const EXEMPT_TTL_MS = 30 * 1000;
let exempt = new Set();
let exemptReadAt = 0;
let exemptReading = null;
// userId -> { on, at }: changes made here in the last minute, laid back over a
// re-read that may have been started before the change was saved.
const exemptChanges = new Map();
function refreshExempt() {
  if (!exemptReading) {
    exemptReading = prisma.user.findMany({ where: { rateExempt: true }, select: { id: true } })
      .then((rows) => {
        const next = new Set(rows.map((r) => r.id));
        const cutoff = Date.now() - 60 * 1000;
        for (const [id, c] of exemptChanges) {
          if (c.at < cutoff) { exemptChanges.delete(id); continue; }
          if (c.on) next.add(id); else next.delete(id);
        }
        exempt = next;
      })
      .catch(() => {})
      .finally(() => { exemptReadAt = Date.now(); exemptReading = null; });
  }
  return exemptReading;
}
/** An admin just changed this account: apply it now, ahead of the next re-read. */
function markExempt(userId, on) {
  if (on) exempt.add(userId); else exempt.delete(userId);
  exemptChanges.set(userId, { on: Boolean(on), at: Date.now() });
  // Either way its counts start clean: what a whitelisted account ran up
  // while nothing was refused must not meet it as a second line the moment
  // it is taken off.
  users.delete(userId);
}
function isExempt(userId, now) {
  if (now - exemptReadAt > EXEMPT_TTL_MS) refreshExempt();
  return exempt.has(userId);
}

// userId -> Map(category -> state)
const users = new Map();

/**
 * What one account has asked for today, for one kind of request.
 *
 * Granted and refused are kept apart. Granted is what the first line is
 * measured against, so a refused request never uses up room. Granted plus
 * refused is what the second line is measured against.
 *
 * For the kinds that count different things, both sides hold ids: a song that
 * was granted can be fetched again (its next byte range, a replay) without
 * counting twice, and a page retrying one refused clip is one refusal, not
 * fifty.
 */
function stateOf(userId, category, now) {
  let byCategory = users.get(userId);
  if (!byCategory) { byCategory = new Map(); users.set(userId, byCategory); }
  let s = byCategory.get(category);
  const day = beijingDay(now);
  if (!s || s.day !== day) {
    const distinct = CATEGORIES[category].distinct;
    s = {
      day,
      // Last ten minutes, oldest first. distinct: id -> time. Otherwise times.
      okTen: distinct ? new Map() : [],
      noTen: distinct ? new Map() : [],
      // Today. distinct: Sets of ids. Otherwise numbers.
      okDay: distinct ? new Set() : 0,
      noDay: distinct ? new Set() : 0,
      episodes: 0,
      lastDeniedAt: 0,
      alertLevel: null,
      alertWrittenAt: 0,
      revoked: false,
    };
    byCategory.set(category, s);
  }
  return s;
}

function pruneOne(box, now) {
  const cutoff = now - TEN_MIN_MS;
  if (Array.isArray(box)) {
    let n = 0;
    while (n < box.length && box[n] <= cutoff) n++;
    if (n) box.splice(0, n);
  } else {
    for (const [id, at] of box) {
      if (at > cutoff) break;
      box.delete(id);
    }
  }
}

/**
 * What is remembered for a song / clip / playlist id: a number, not the string.
 *
 * The id arrives as a piece of the request URL, and a piece of a string keeps
 * the whole string alive — here the whole URL, login token included, some 400
 * bytes for every clip an account plays in a day. Measured at ~27 MB for an
 * ordinary day's listening; as numbers the same day is ~3 MB.
 *
 * 52 bits taken from the random parts of the UUID (its first 8 and last 5 hex
 * digits). Two of one account's few thousand ids sharing all 52 is a
 * one-in-a-billion event, and would only mean one song counted as another.
 * Anything that is not a UUID is hashed to the same range.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function keyOf(id) {
  const s = String(id);
  if (s.length === 36 && UUID_SHAPE.test(s)) {
    return parseInt(s.slice(0, 8), 16) * 1048576 + parseInt(s.slice(31), 16);
  }
  let hi = 0x811c9dc5; let lo = 0x01000193;
  for (let i = 0; i < s.length && i < 256; i++) {
    const c = s.charCodeAt(i);
    hi = Math.imul(hi ^ c, 0x01000193) >>> 0;
    lo = Math.imul(lo + c, 0x9e3779b1) >>> 0;
  }
  return (hi >>> 0) * 1048576 + (lo >>> 12);
}

const sizeOf = (x) => (typeof x === 'number' ? x : (x.size !== undefined ? x.size : x.length));
const RANK = { first: 1, repeat: 2, revoke: 3 };

/**
 * Count one request and say whether it may go ahead.
 *
 * @returns {null | {window:'ten'|'day', count:number, limit:number}} null when
 *   allowed; otherwise which line it would have crossed, and the number of
 *   requests (granted + refused) made in that window.
 */
function consume(user, category, id, now = Date.now()) {
  const cat = CATEGORIES[category];
  if (!cat || !user || user.role === 'ADMIN') return null;
  const cfg = currentConfig(now);
  const lim = cfg.limits[category];
  const s = stateOf(user.id, category, now);
  pruneOne(s.okTen, now);
  pruneOne(s.noTen, now);
  const whitelisted = isExempt(user.id, now);

  let overTen;
  let overDay;
  if (cat.distinct) {
    const key = keyOf(id);
    const hadTen = s.okTen.has(key);
    const hadDay = s.okDay.has(key);
    overTen = lim.ten != null && !hadTen && s.okTen.size + 1 > lim.ten;
    overDay = lim.day != null && !hadDay && s.okDay.size + 1 > lim.day;
    if (!overTen && !overDay) {
      s.okTen.delete(key); // re-inserted at the newest end
      s.okTen.set(key, now);
      s.okDay.add(key);
      // Refused earlier and granted now: it is one request, not two.
      if (s.noTen.size) s.noTen.delete(key);
      if (s.noDay.size) s.noDay.delete(key);
      return null;
    }
    // Refused (or, for a whitelisted account, over the line and let through:
    // counted on the same side, so the totals below read the same either
    // way). Kept only up to the second line: a program that never stops must
    // not be able to grow these without bound.
    const capTen = lim.ten == null ? 0 : Math.ceil(lim.ten * cfg.revokeFactor);
    const capDay = lim.day == null ? 0 : Math.ceil(lim.day * cfg.revokeFactor);
    if (s.noTen.has(key)) { s.noTen.delete(key); s.noTen.set(key, now); }
    else if (s.okTen.size + s.noTen.size < capTen) s.noTen.set(key, now);
    if (!hadDay && !s.noDay.has(key) && s.okDay.size + s.noDay.size < capDay) s.noDay.add(key);
  } else {
    overTen = lim.ten != null && s.okTen.length + 1 > lim.ten;
    overDay = lim.day != null && s.okDay + 1 > lim.day;
    if (!overTen && !overDay) {
      s.okTen.push(now);
      s.okDay += 1;
      return null;
    }
    const capTen = lim.ten == null ? 0 : Math.ceil(lim.ten * cfg.revokeFactor);
    const capDay = lim.day == null ? 0 : Math.ceil(lim.day * cfg.revokeFactor);
    if (s.okTen.length + s.noTen.length < capTen) s.noTen.push(now);
    if (s.okDay + s.noDay < capDay) s.noDay += 1;
  }

  const ten = sizeOf(s.okTen) + sizeOf(s.noTen);
  const day = sizeOf(s.okDay) + sizeOf(s.noDay);
  const window = overDay ? 'day' : 'ten';
  const count = overDay ? day : ten;
  const limit = overDay ? lim.day : lim.ten;

  if (now - s.lastDeniedAt > EPISODE_GAP_MS) s.episodes += 1;
  s.lastDeniedAt = now;

  const atSecondLine = (lim.ten != null && ten >= Math.ceil(lim.ten * cfg.revokeFactor))
    || (lim.day != null && day >= Math.ceil(lim.day * cfg.revokeFactor));
  let level = 'first';
  if (overDay || s.episodes >= REPEAT_EPISODES) level = 'repeat';
  if (atSecondLine) level = 'revoke';

  // What the alert shows. When a second line has been reached it is that
  // window's count, whichever window refused this particular request.
  let shown = { window, count, limit };
  if (atSecondLine) {
    shown = lim.ten != null && ten >= Math.ceil(lim.ten * cfg.revokeFactor)
      ? { window: 'ten', count: ten, limit: lim.ten }
      : { window: 'day', count: day, limit: lim.day };
  }

  const worse = !s.alertLevel || RANK[level] > RANK[s.alertLevel];
  if (worse || now - s.alertWrittenAt > ALERT_REFRESH_MS) {
    const revokeNow = level === 'revoke' && cfg.autoRevoke && !s.revoked && !whitelisted && !cat.noRevoke;
    const levelBefore = s.alertLevel;
    if (revokeNow) s.revoked = true; // one attempt in flight; undone below if it fails
    if (worse) s.alertLevel = level;
    s.alertWrittenAt = now;
    // One write at a time for this row, in the order they were decided: two
    // at once could both try to create it.
    const write = {
      user, category, day: s.day, level: s.alertLevel, ...shown,
      episodes: s.episodes, revokeNow, now, exempt: whitelisted,
    };
    s.writing = (s.writing || Promise.resolve())
      .then(() => recordAlert(write))
      .then((revoked) => {
        if (revokeNow && !revoked) s.revoked = false; // try again at the next write
      })
      .catch((err) => {
        // Not recorded: put back what was assumed, so the next refusal writes it.
        s.alertLevel = levelBefore;
        s.alertWrittenAt = 0;
        if (revokeNow) s.revoked = false;
        console.error('[rate-guard] could not record alert:', err.message);
      });
  }

  // Whitelisted: recorded above, never refused.
  return whitelisted ? null : { window, count, limit };
}

/**
 * Write (or update) today's row for this user and kind of request, and revoke
 * the account when asked to. Runs after the response has been decided; the
 * request never waits for it.
 */
async function recordAlert({ user, category, day, level, window, count, limit, episodes, revokeNow, now, exempt: wasExempt = false }) {
  const at = new Date(now);
  const rowKey = { userId_category_day: { userId: user.id, category, day } };
  // What is already written for today is the floor. This process forgets its
  // counts on a restart, and a row that said "revoke" before one must not be
  // rewritten as "first", nor a dismissed row reopened, by the first refusal
  // after it.
  const existing = await prisma.rateAlert.findUnique({
    where: rowKey,
    select: { level: true, window: true, count: true, episodes: true },
  });
  let finalLevel = level;
  if (!existing && finalLevel === 'first') {
    // Over a line yesterday as well: that is a habit, not an accident.
    const yesterday = beijingDay(now - 24 * 3600 * 1000);
    const before = await prisma.rateAlert.findFirst({
      where: { userId: user.id, day: yesterday },
      select: { id: true },
    });
    if (before) finalLevel = 'repeat';
  }
  if (existing && RANK[existing.level] > RANK[finalLevel]) finalLevel = existing.level;
  const raised = !existing || RANK[finalLevel] > RANK[existing.level];

  let username = user.username;
  if (!username) {
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { username: true } });
    username = row ? row.username : '(unknown)';
  }

  let autoRevoked = false;
  if (revokeNow) {
    try {
      // Required here, not at the top, so loading this file never depends on
      // the admin service having loaded first.
      await require('./adminService').demoteUser(user.id);
      autoRevoked = true;
      // Forget what it had used, here and now (not after the write below,
      // which may fail): if an admin lets it back in today it starts from
      // nothing, and can be revoked again.
      users.delete(user.id);
      console.warn(`[rate-guard] revoked ${username}: ${category} ${count}/${limit} (${window})`);
    } catch (err) {
      console.error('[rate-guard] could not revoke:', err.message);
    }
  }

  await prisma.rateAlert.upsert({
    where: rowKey,
    create: {
      userId: user.id, username, category, day, level: finalLevel, window, count,
      limitValue: limit, episodes, autoRevoked, exempt: wasExempt, firstAt: at, lastAt: at,
    },
    update: {
      window,
      limitValue: limit,
      // Never smaller than what is written: after a restart this process
      // counts from nothing again.
      count: existing && existing.window === window ? Math.max(existing.count, count) : count,
      episodes: existing ? Math.max(existing.episodes, episodes) : episodes,
      lastAt: at,
      exempt: wasExempt,
      level: finalLevel,
      ...(autoRevoked ? { autoRevoked: true } : {}),
      // Worse than what is written: show it again if it had been dismissed.
      ...(raised ? { ackedAt: null } : {}),
    },
  });
  if (raised) {
    console.warn(`[rate-guard] ${finalLevel} ${username}: ${category} ${count}/${limit} (${window})`);
  }
  return autoRevoked;
}

function limitedError() {
  const err = new AppError(MESSAGE, 429);
  err.code = 'RATE_LIMITED';
  return err;
}

/**
 * Express middleware: count this request against `category`.
 * @param {string} category  a key of CATEGORIES
 * @param {(req) => string} [idOf]  what is being asked for, for the kinds that
 *   count different things rather than requests
 */
function guard(category, idOf) {
  return (req, res, next) => {
    const hit = consume(req.user, category, idOf ? idOf(req) : null);
    if (hit) return next(limitedError());
    next();
  };
}

// Every ten minutes: accounts that have not asked for anything today are
// dropped, so the map is bounded by the people active on one day; and the
// ten-minute windows of accounts that have gone quiet are emptied, which
// otherwise only happens on their next request.
const sweep = setInterval(() => {
  const now = Date.now();
  const today = beijingDay(now);
  for (const [userId, byCategory] of users) {
    for (const [category, s] of byCategory) {
      if (s.day !== today) { byCategory.delete(category); continue; }
      pruneOne(s.okTen, now);
      pruneOne(s.noTen, now);
    }
    if (!byCategory.size) users.delete(userId);
  }
}, TEN_MIN_MS);
sweep.unref();

/** For tests: forget every count. */
function reset() {
  users.clear();
  exemptChanges.clear();
  exempt = new Set();
  exemptReadAt = Date.now();
  config = normalize(null);
  configReadAt = Date.now();
}

module.exports = {
  CATEGORIES, DEFAULTS, MESSAGE, guard, consume, limitedError,
  getConfig, setConfig, normalize, beijingDay, reset, refreshExempt, markExempt, keyOf,
  // exposed for tests only
  _setConfigForTest: (c) => { config = normalize(c); configReadAt = Date.now(); },
};
