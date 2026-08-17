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
// The handler reads statusCode and isOperational; a bare Error with .status
// becomes a 500 with its message replaced by 'Internal server error'.
const { NotFoundError, ValidationError } = require('../utils/errors');

const PLATFORMS = ['qq', 'netease'];
const NAMESPACE = 'musicSources';

function assertPlatform(platform) {
  if (!PLATFORMS.includes(platform)) {
    throw new ValidationError({ platform: [`未知的音乐平台: ${platform}`] });
  }
}

async function readPreferences(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user) {
    throw new NotFoundError('User');
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
    throw new ValidationError({ cookie: ['Cookie 不能为空'] });
  }

  const parsed = platform === 'qq' ? parseQqCookie(raw) : parseNeteaseCookie(raw);
  if (platform === 'qq' && (!parsed.uin || !parsed.musicKey)) {
    throw new ValidationError({ cookie: ['这份 cookie 里没有找到 uin 和 qm_keyst，请确认复制完整'] });
  }
  if (platform === 'netease' && !parsed.musicU) {
    throw new ValidationError({ cookie: ['这份 cookie 里没有找到 MUSIC_U，请确认复制完整'] });
  }

  const preferences = await readPreferences(userId);
  const sources = { ...(preferences[NAMESPACE] || {}) };

  sources[platform] = {
    cookie: vault.encrypt(raw),
    uin: parsed.uin ?? extra.uin ?? null,
    // How the credential was obtained. It decides whether renewal is possible
    // at all: only a QR login yields refresh_key, so a pasted cookie has to be
    // replaced by hand every few days.
    method: extra.method || 'paste',
    // Encrypted like the cookie — it is a credential in its own right, enough
    // to mint fresh keys for this account.
    refreshKey: extra.refreshKey ? vault.encrypt(extra.refreshKey) : null,
    refreshToken: extra.refreshToken ? vault.encrypt(extra.refreshToken) : null,
    // Not secret on their own, but the renewal call is rejected without them,
    // so they are stored alongside rather than rediscovered later.
    openid: extra.openid ?? null,
    unionid: extra.unionid ?? null,
    strMusicId: extra.strMusicId ?? null,
    refreshable: Boolean(extra.refreshKey) || Boolean(parsed.refreshable),
    savedAt: new Date().toISOString(),
    // The platform states both of these outright on a QR login, so they beat
    // anything inferred from a cookie's own expiry attribute.
    expiresAt: extra.expiresAt ?? null,
    needRefreshInSec: extra.needRefreshInSec ?? null,
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
 * How close a credential is to being useless.
 *
 * Returned to the browser so a page can warn before playback starts failing.
 * The alternative is what happens today: everything looks connected until a
 * song will not play, with nothing on screen explaining why.
 *
 *   ok        plenty of time left, or nothing to warn about
 *   soon      inside a day — mention it, do not interrupt
 *   urgent    inside six hours — say it loudly
 *   expired   already dead
 */
const SOON_MS = 24 * 60 * 60 * 1000;
const URGENT_MS = 6 * 60 * 60 * 1000;

function expiryState(entry) {
  if (!entry?.expiresAt) return { level: 'ok', expiresInMs: null };
  const left = new Date(entry.expiresAt).getTime() - Date.now();
  if (Number.isNaN(left)) return { level: 'ok', expiresInMs: null };
  if (left <= 0) return { level: 'expired', expiresInMs: 0 };
  if (left <= URGENT_MS) return { level: 'urgent', expiresInMs: left };
  if (left <= SOON_MS) return { level: 'soon', expiresInMs: left };
  return { level: 'ok', expiresInMs: left };
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
      // How it was obtained, and whether that means it can renew itself. A
      // pasted cookie cannot, so the page tells the user to expect to redo it.
      method: entry.method || 'paste',
      refreshable: Boolean(entry.refreshable),
      expiresAt: entry.expiresAt ?? null,
      // So a page can warn before playback starts failing rather than after.
      ...expiryState(entry),
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
 * Everything the renewal call needs, decrypted. Server-side only.
 *
 * Separate from getCredential() because renewal wants the whole chain — the
 * refresh key, the tokens, the ids — while playback only wants a cookie.
 * Returns null when this credential cannot be renewed at all, which is the
 * normal case for a pasted one.
 */
async function getRefreshable(userId, platform) {
  assertPlatform(platform);
  const preferences = await readPreferences(userId);
  const entry = (preferences[NAMESPACE] || {})[platform];
  if (!entry?.refreshKey || !entry?.cookie) return null;

  const cookie = vault.decrypt(entry.cookie);
  const parsed = platform === 'qq' ? parseQqCookie(cookie) : {};
  return {
    uin: entry.uin || parsed.uin || null,
    musicKey: parsed.musicKey || null,
    refreshKey: vault.decrypt(entry.refreshKey),
    refreshToken: entry.refreshToken ? vault.decrypt(entry.refreshToken) : null,
    openid: entry.openid ?? null,
    unionid: entry.unionid ?? null,
    strMusicId: entry.strMusicId ?? null,
    expiresAt: entry.expiresAt ?? null,
    needRefreshInSec: entry.needRefreshInSec ?? null,
  };
}

/**
 * Is it time to renew this credential?
 *
 * The platform states how long the key lasts and when it wants to see a
 * renewal, so this leans on that rather than a schedule of our own. The margin
 * exists because renewing slightly early is free while renewing late is not:
 * once the key dies the refresh chain dies with it and the user has to rescan.
 */
const REFRESH_MARGIN_MS = 12 * 60 * 60 * 1000;

async function needsRefresh(userId, platform) {
  const preferences = await readPreferences(userId);
  const entry = (preferences[NAMESPACE] || {})[platform];
  if (!entry?.refreshKey) return false;
  if (!entry.expiresAt) return false;
  const left = new Date(entry.expiresAt).getTime() - Date.now();
  if (Number.isNaN(left)) return false;
  return left <= REFRESH_MARGIN_MS;
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
  getRefreshable,
  needsRefresh,
  expiryState,
  clearCredential,
  getStatus,
  getCredential,
  recordCheck,
  parseQqCookie,
  parseNeteaseCookie,
};
