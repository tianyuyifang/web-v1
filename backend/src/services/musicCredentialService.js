/**
 * Per-user QQ / NetEase credentials.
 *
 * Stored encrypted inside User.preferences under a `musicSources` key. That
 * column is JsonB and already exists, so this costs no migration; the tradeoff
 * is that every write has to merge rather than replace, since preferences also
 * holds the user's theme and language.
 *
 * The one rule that matters: getStatus() is the only thing the browser ever
 * sees, and it never contains a credential. Cookies leave this module solely
 * through getCredential(), which is for server-side outbound calls. A cookie
 * that reached the browser could be copied out of a devtools panel or a
 * screenshot, and it is the user's platform account on the line, not ours.
 */
const prisma = require('../db/client');
const vault = require('../utils/cookieVault');

const PLATFORMS = ['qq', 'netease'];
const NAMESPACE = 'musicSources';

function assertPlatform(platform) {
  if (!PLATFORMS.includes(platform)) {
    const err = new Error(`Unknown music platform: ${platform}`);
    err.code = 'UNKNOWN_PLATFORM';
    err.status = 400;
    throw err;
  }
}

async function readPreferences(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  // preferences can be null on old rows.
  return user.preferences && typeof user.preferences === 'object' ? user.preferences : {};
}

/**
 * Pull the fields QQ needs out of a pasted cookie string.
 *
 * The vkey service authenticates on uin plus the music key, and those two are
 * spread across several aliases depending on how the user logged in — a WeChat
 * login writes wxuin where a QQ login writes uin. Parsing here means the user
 * can paste the whole cookie header instead of hunting for individual fields.
 */
function parseQqCookie(cookie) {
  const jar = {};
  for (const part of String(cookie).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const uin = jar.uin || jar.wxuin || jar.qqmusic_uin || null;
  const musicKey = jar.qm_keyst || jar.qqmusic_key || null;
  return {
    uin: uin ? String(uin).replace(/^o0*/, '') : null,
    musicKey,
    // Absent on a WeChat login, which is how we know a refresh will not work
    // and the user has to repaste every few days.
    refreshable: Boolean(jar.psrf_qqrefresh_token || jar.refresh_key),
  };
}

function parseNeteaseCookie(cookie) {
  const jar = {};
  for (const part of String(cookie).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return { musicU: jar.MUSIC_U || null };
}

/**
 * Store a credential, replacing whatever was there.
 *
 * Merges into preferences rather than overwriting it: the same column carries
 * the user's theme and language, and a blind write would silently reset them.
 */
async function setCredential(userId, platform, cookie, extra = {}) {
  assertPlatform(platform);

  const raw = String(cookie || '').trim();
  if (!raw) {
    const err = new Error('Cookie is empty');
    err.code = 'EMPTY_COOKIE';
    err.status = 400;
    throw err;
  }

  const parsed = platform === 'qq' ? parseQqCookie(raw) : parseNeteaseCookie(raw);
  if (platform === 'qq' && (!parsed.uin || !parsed.musicKey)) {
    const err = new Error('这份 cookie 里没有找到 uin 和 qm_keyst，请确认复制完整');
    err.code = 'INCOMPLETE_COOKIE';
    err.status = 400;
    throw err;
  }
  if (platform === 'netease' && !parsed.musicU) {
    const err = new Error('这份 cookie 里没有找到 MUSIC_U，请确认复制完整');
    err.code = 'INCOMPLETE_COOKIE';
    err.status = 400;
    throw err;
  }

  const preferences = await readPreferences(userId);
  const sources = { ...(preferences[NAMESPACE] || {}) };

  sources[platform] = {
    cookie: vault.encrypt(raw),
    uin: parsed.uin ?? null,
    // Not a credential — just how the account page explains that a WeChat
    // login has to be repasted every few days while a QQ login does not.
    refreshable: Boolean(parsed.refreshable),
    savedAt: new Date().toISOString(),
    // Filled in by recordCheck() once the platform has actually been asked.
    // Saving a cookie proves it parsed, not that it works.
    vipType: extra.vipType ?? null,
    nickname: extra.nickname ?? null,
    checkedAt: extra.checkedAt ?? null,
    lastError: null,
  };

  await prisma.user.update({
    where: { id: userId },
    data: { preferences: { ...preferences, [NAMESPACE]: sources } },
  });

  return getStatus(userId, platform);
}

/** Forget a stored credential. */
async function clearCredential(userId, platform) {
  assertPlatform(platform);
  const preferences = await readPreferences(userId);
  const sources = { ...(preferences[NAMESPACE] || {}) };
  if (!sources[platform]) return { platform, connected: false };

  delete sources[platform];
  await prisma.user.update({
    where: { id: userId },
    data: { preferences: { ...preferences, [NAMESPACE]: sources } },
  });
  return { platform, connected: false };
}

/**
 * What the browser is allowed to know.
 *
 * Never includes the cookie, and deliberately not the raw uin either — it
 * identifies the platform account and the page has no use for it.
 */
async function getStatus(userId, platform = null) {
  const preferences = await readPreferences(userId);
  const sources = preferences[NAMESPACE] || {};

  const describe = (name) => {
    const entry = sources[name];
    if (!entry) return { platform: name, connected: false };
    return {
      platform: name,
      connected: true,
      // null until a real call has been made, so the page can say "not
      // verified yet" instead of implying it works.
      vipType: entry.vipType ?? null,
      nickname: entry.nickname ?? null,
      checkedAt: entry.checkedAt ?? null,
      savedAt: entry.savedAt ?? null,
      // WeChat logins cannot be renewed automatically; the page uses this to
      // warn that the cookie needs repasting every few days.
      refreshable: Boolean(entry.refreshable),
      lastError: entry.lastError ?? null,
    };
  };

  if (platform) {
    assertPlatform(platform);
    return describe(platform);
  }
  return PLATFORMS.map(describe);
}

/**
 * Decrypt a credential for an outbound call. Server-side only.
 *
 * Returns null when nothing is stored, so callers can offer to connect. A
 * stored-but-unreadable credential throws instead: that means the vault key
 * changed or the row was tampered with, and quietly treating it as "not
 * connected" would send the user round in circles re-entering a cookie that
 * was already there.
 */
async function getCredential(userId, platform) {
  assertPlatform(platform);
  const preferences = await readPreferences(userId);
  const entry = (preferences[NAMESPACE] || {})[platform];
  if (!entry || !entry.cookie) return null;

  const cookie = vault.decrypt(entry.cookie);
  if (platform === 'qq') {
    const parsed = parseQqCookie(cookie);
    return { cookie, uin: entry.uin || parsed.uin, musicKey: parsed.musicKey };
  }
  return { cookie, ...parseNeteaseCookie(cookie) };
}

/**
 * Record what the platform said about this credential.
 *
 * Saving a cookie only proves it parsed. Whether it works — and whether the
 * account actually has VIP — is something only the platform can answer, and
 * the answer matters: a non-VIP account signs in perfectly and then fails on
 * most songs, which looks like a broken feature rather than a missing
 * subscription.
 */
async function recordCheck(userId, platform, { ok, vipType, nickname, error } = {}) {
  assertPlatform(platform);
  const preferences = await readPreferences(userId);
  const sources = { ...(preferences[NAMESPACE] || {}) };
  if (!sources[platform]) return getStatus(userId, platform);

  sources[platform] = {
    ...sources[platform],
    checkedAt: new Date().toISOString(),
    vipType: ok ? (vipType ?? sources[platform].vipType ?? null) : sources[platform].vipType ?? null,
    nickname: ok ? (nickname ?? sources[platform].nickname ?? null) : sources[platform].nickname ?? null,
    lastError: ok ? null : (error || 'unknown'),
  };

  await prisma.user.update({
    where: { id: userId },
    data: { preferences: { ...preferences, [NAMESPACE]: sources } },
  });
  return getStatus(userId, platform);
}

module.exports = {
  PLATFORMS,
  NAMESPACE,
  setCredential,
  clearCredential,
  getStatus,
  getCredential,
  recordCheck,
  parseQqCookie,
  parseNeteaseCookie,
};
