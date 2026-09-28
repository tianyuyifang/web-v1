/**
 * One face over the two platforms for 平台打标.
 *
 * The page and the tagging service speak in playlist refs ("qq:<tid>",
 * "netease:<id>") and song ids, and never learn which platform quirk is
 * underneath: QQ wants a numeric id plus a type and answers "is it liked"
 * per id, NetEase wants the id alone and answers with the liked subset. Both
 * are flattened here.
 *
 * Every call is made with the calling user's own stored credential — the
 * same one playback uses — so a like lands in their account and spends their
 * quota, never the server's. Writes are serialised per user: the game can
 * surface several songs in one screen read, and two likes in flight at once
 * is the traffic shape these platforms treat as automation.
 */
const access = require('./musicCredentialAccess');
const credentials = require('./musicCredentialService');
const qq = require('./sources/qqSource');
const netease = require('./sources/neteaseLogin');
const { AppError, ValidationError } = require('../utils/errors');

const PLATFORMS = Object.freeze(['qq', 'netease']);
const REF_RE = /^(qq|netease):([A-Za-z0-9_-]{1,64})$/;

/** Split "qq:123" into its parts, or refuse it as a bad request. */
function parseRef(ref) {
  const m = REF_RE.exec(String(ref || ''));
  if (!m) throw new ValidationError({ playlistRef: ['歌单引用格式不对'] });
  return { platform: m[1], id: m[2], ref: `${m[1]}:${m[2]}` };
}

function assertPlatform(platform) {
  if (!PLATFORMS.includes(platform)) {
    throw new ValidationError({ platform: ['未知的音乐平台'] });
  }
  return platform;
}

/**
 * The stored credential, renewed if it is about to lapse. A missing one is a
 * 400 the page can answer with "go connect it", not a 500.
 */
async function credentialFor(userId, platform) {
  const cred = await access.getFreshCredential(userId, assertPlatform(platform));
  if (!cred) {
    throw appError(
      platform === 'qq' ? '还没连接 QQ 音乐账号' : '还没连接网易云账号',
      400,
      'PLATFORM_NOT_CONNECTED',
    );
  }
  return cred;
}

/** AppError takes (message, status); the machine-readable code rides alongside. */
function appError(message, status, code) {
  const err = new AppError(message, status);
  err.code = code;
  return err;
}

/** Errors from the source modules carry a status; give them the app's shape. */
function rethrow(err) {
  if (err instanceof AppError) throw err;
  // Never 401/403 from here: those are the site's own auth statuses. The
  // browser interceptor logs the user out on a 401 and the capture client
  // drops its pairing on one. A lapsed platform login is neither, so it goes
  // out as 409 with its own code.
  let status = Number.isInteger(err.status) ? err.status : 502;
  if (status === 401 || status === 403) status = 409;
  const wrapped = appError(err.message || '平台请求失败', status, err.code || 'PLATFORM_CALL_FAILED');
  wrapped.platformCode = err.platformCode;
  throw wrapped;
}

/**
 * Run one platform call as the user, renewing a dead QQ key once.
 *
 * Scheduled renewal covers the expected case; this covers a key that dies
 * before the platform said it would. The playback path does the same
 * (renewAfterRejection) and a user whose playback quietly heals should not
 * be told here to rescan. One attempt, no loop: if the refresh key is dead
 * too, only a new scan can help.
 */
async function run(userId, platform, fn) {
  const cred = await credentialFor(userId, platform);
  try {
    return await fn(cred);
  } catch (err) {
    if (platform === 'qq' && err.code === 'PLATFORM_CREDENTIAL_EXPIRED') {
      const fresh = await access.renewAfterRejection(userId);
      if (fresh) {
        try {
          return await fn(fresh);
        } catch (err2) {
          return rethrow(err2);
        }
      }
    }
    return rethrow(err);
  }
}

/** Created + collected playlists, favourites first. */
async function listPlaylists(userId, platform) {
  assertPlatform(platform);
  return run(userId, platform, async (cred) => {
    if (platform !== 'qq') return netease.listMyPlaylists(cred.cookie);
    const { playlists, euin, euinResolved } = await qq.listMyPlaylists(cred);
    // Resolved off a playlist this time: keep it, so the next listing is one
    // call fewer. Bookkeeping only; a failure to store costs nothing now.
    if (euinResolved) credentials.setEncryptUin(userId, 'qq', euin).catch(() => {});
    return playlists;
  });
}

/**
 * The songs in one playlist, in the shape `matchTitle` reads ({id, title,
 * artist}) plus what a like needs (songType).
 *
 * `dirId` matters to QQ only: its favourites are read by dirId 201 with
 * disstid 0. The page has it from the listing; callers that do not pass one
 * get the ordinary tid read.
 */
async function getPlaylistSongs(userId, ref, { dirId = null } = {}) {
  const { platform, id } = parseRef(ref);
  return run(userId, platform, (cred) => (platform === 'qq'
    ? qq.getPlaylistRows(id, { ...cred, dirId })
    : netease.getPlaylistRows(id, { cookie: cred.cookie })));
}

/** id → already liked, for every id asked about. */
async function likedMap(userId, platform, ids) {
  if (!ids.length) return new Map();
  assertPlatform(platform);
  return run(userId, platform, (cred) => (platform === 'qq'
    ? qq.likedMap(ids, cred)
    : netease.likedMap(cred.cookie, ids)));
}

/**
 * Per-user write queue. A like waits for the previous like from the same user
 * to finish (and be verified) before it leaves. Different users do not wait on
 * each other — the platform sees them as different accounts anyway.
 */
const queues = new Map(); // userId → Promise

function serialised(userId, fn) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(userId, next);
  next.catch(() => {}).finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  return next;
}

/**
 * Like one song in the user's platform account, verified by reading back.
 *
 * Idempotent from the caller's view: a song that is already liked answers
 * `{ ok: true, alreadyLiked: true }` without writing, because both platforms
 * accept a repeat add but there is no reason to send one.
 */
async function like(userId, platform, { id, songType = 0, knownUnliked = false }) {
  assertPlatform(platform);
  if (!id) throw new ValidationError({ id: ['缺少歌曲 id'] });
  return serialised(userId, () => run(userId, platform, async (cred) => {
    // The pre-check is skipped when the caller has just consulted a fresh
    // liked sweep for this id (the capture path does): the write itself is
    // idempotent, and the read-back below is the verification either way.
    if (!knownUnliked) {
      const before = platform === 'qq'
        ? await qq.likedMap([id], cred)
        : await netease.likedMap(cred.cookie, [id]);
      if (before.get(String(id))) return { ok: true, alreadyLiked: true };
    }
    if (platform === 'qq') await qq.likeSong({ id, songType }, cred);
    else await netease.likeSong(cred.cookie, id);
    return { ok: true, alreadyLiked: false };
  }));
}

/**
 * Unlike one song, verified by reading back. Only ever reached from the
 * page's own heart button -- the capture path never calls this, so a repeated
 * capture can never turn a like off.
 */
async function unlike(userId, platform, { id, songType = 0 }) {
  assertPlatform(platform);
  if (!id) throw new ValidationError({ id: ['缺少歌曲 id'] });
  return serialised(userId, () => run(userId, platform, async (cred) => {
    if (platform === 'qq') await qq.unlikeSong({ id, songType }, cred);
    else await netease.unlikeSong(cred.cookie, id);
    return { ok: true };
  }));
}

module.exports = {
  PLATFORMS, parseRef, listPlaylists, getPlaylistSongs, likedMap, like, unlike,
  // QQ's fixed dirId for "我喜欢", so callers need not know which module owns it.
  QQ_LIKES_DIR_ID: qq.LIKES_DIR_ID,
};
