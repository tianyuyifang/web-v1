/**
 * 平台打标 — auto-tagging into the user's own QQ / NetEase account.
 *
 * The playlist page likes into one of OUR playlists; this likes into the
 * user's "我喜欢" on the platform, using one of THEIR playlists as the set of
 * songs the game's titles are matched against. The capture side is shared —
 * same client, same token, same connection — and only the destination differs:
 * a session aimed at `target: 'platform'` sends its captures here.
 *
 * Rows go to their own table. capture_events is read by the report, the marked
 * list, the passage catalogue and the prune script, and none of them should
 * ever see a platform run.
 *
 * The matching rules are the ones the playlist page settled on and are not
 * relaxed here: `matchTitle` is called as-is, and only an exact match with a
 * single candidate is acted on without asking. A wrong like here lands in the
 * user's real favourites rather than in a shared playlist, so if anything the
 * bar is higher, not lower.
 */
const prisma = require('../db/client');
const { matchTitle } = require('./captureMatchService');
const likes = require('./platformLikeService');
const apkLikes = require('./apkLikeService');
const apkChannel = require('./apkChannel');
const gepSingers = require('./gepSingerService');
const { searchTextFor } = require('../utils/searchText');
const captureService = require('./captureService');
const { broadcast } = require('./sseManager');
const settingsService = require('./settingsService');
const { AppError, ValidationError, NotFoundError } = require('../utils/errors');

const MAX_TEXT_LENGTH = 200;

/** SSE channel for a user's platform runs. Keyed by user, like 唱卡. */
function channel(userId) {
  return `platform-tag:${userId}`;
}

/**
 * The songs of the playlist a session is aimed at, plus which are already
 * liked, kept for the run.
 *
 * Fetched once when the user aims (or opens the list) and reused for every
 * capture and every click, so a game of a hundred titles costs one playlist
 * read and one liked-state sweep rather than one per title. In memory, not the
 * database: the platform is the source of truth and the list only has to last
 * a run. A restart drops it and the next capture fetches it again.
 *
 * A failed read is remembered too, briefly. The client re-sends every title on
 * screen every 2s until one is accepted, so without this a lapsed login would
 * turn into a fresh platform read per title per sweep, under the user's own
 * credential -- the exact traffic shape the platforms treat as automation.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
// A QQ list exists here only because the user's browser read and supplied it
// (the server never reads QQ), so it is kept for as long as a run lasts --
// re-reading it means asking the page to do it again.
const SUPPLIED_TTL_MS = 6 * 60 * 60 * 1000;
const songCache = new Map(); // `${userId}|${ref}` -> { at, dirId, title, songs, liked, error }

function cacheKey(userId, ref) {
  return `${userId}|${ref}`;
}

/** Drop entries past their time, so aimed-at lists do not pile up for the life of the process. */
function sweep() {
  const now = Date.now();
  for (const [k, v] of songCache) {
    // The long life is for the list a run is aimed at; others the browser
    // supplied while browsing go after the usual ten minutes (a 5000-song
    // list is several MB here).
    const [uid, ref] = k.split('|');
    const runList = v.supplied && runRefs.get(uid) === ref;
    const ttl = v.error ? FAIL_TTL_MS : runList ? SUPPLIED_TTL_MS : CACHE_TTL_MS;
    if (now - v.at > ttl) songCache.delete(k);
  }
}

/**
 * QQ reads "我喜欢" by dirId, and the dirId is only known from the listing.
 * When a cold read has none (a restart mid-run), it is looked up once rather
 * than guessed.
 */
async function resolveDirId(userId, ref) {
  const { platform } = likes.parseRef(ref);
  if (platform !== 'qq') return null;
  // Created lists only: the dirId is on one of those, and the collected
  // half is up to three more platform calls that would tell us nothing.
  const lists = await likes.listPlaylists(userId, platform, { collected: false });
  const hit = lists.find((p) => p.ref === ref);
  return hit ? hit.dirId ?? null : null;
}

/**
 * `isLikes` -- is this the favourites list itself? It is the one list whose
 * rows change on a like, so it is the one dropped by setLikedState. QQ says so
 * by dirId; NetEase only in the listing, which the page has and passes along.
 * Used for cache bookkeeping only, so a wrong value costs a stale row, never
 * a wrong write.
 */
/**
 * Which refs are a user's favourites list, remembered for the process.
 *
 * The listing says so (isLikes) and the page passes it along on the read
 * that follows -- but a refill from the capture path, or after a restart,
 * carries no such hint. Remembering the answer here means the favourites
 * entry stays recognisable across refills; QQ's is also known by dirId.
 */
const favouriteRefs = new Set(); // `${userId}|${ref}`

/**
 * A QQ list that is not here: the server does not read QQ (QQ打标 is user-IP
 * only), so the page has to read it and supply it again.
 */
function listNotLoaded() {
  const e = new AppError('这个歌单还没从你的浏览器读取，请在 QQ打标 页面打开它', 409);
  e.code = 'QQ_LIST_NOT_LOADED';
  return e;
}

async function songsFor(userId, ref, dirId, isLikes = false) {
  sweep();
  const key = cacheKey(userId, ref);
  if (isLikes) favouriteRefs.add(key);
  const hit = songCache.get(key);
  if (!hit && likes.parseRef(ref).platform === 'qq') throw listNotLoaded();
  if (hit) {
    if (hit.error) throw hit.error;
    // A read in flight is shared: the client sends every title on screen in
    // one sweep, and on a cold cache each would otherwise start its own
    // full playlist read as the user.
    if (hit.pending) return hit.pending;
    // Sliding, not fixed: a game runs longer than ten minutes, and a list in
    // use should not be re-read from the platform on a wall-clock schedule.
    hit.at = Date.now();
    return hit;
  }

  // The placeholder is what the finished read replaces -- and only while it
  // is still the entry in the cache. A refresh (or a sweep) that removed it
  // in the meantime has said this read's answer is not wanted, and letting
  // it land anyway would put an older snapshot over a newer one.
  const placeholder = { at: Date.now(), pending: null };
  placeholder.pending = (async () => {
    try {
      const { platform } = likes.parseRef(ref);
      const effectiveDirId = dirId ?? await resolveDirId(userId, ref);
      const { title, songs } = await likes.getPlaylistSongs(userId, ref, { dirId: effectiveDirId });
      const liked = await likes.likedMap(userId, platform, songs.map((x) => x.id));
      for (const s of songs) s.searchText = searchTextFor(s.title, s.artist);
      const entry = {
        at: Date.now(),
        dirId: effectiveDirId,
        isLikes: favouriteRefs.has(key) || effectiveDirId === likes.QQ_LIKES_DIR_ID,
        title,
        songs,
        liked,
      };
      if (entry.isLikes) favouriteRefs.add(key);
      if (songCache.get(key) === placeholder) songCache.set(key, entry);
      return entry;
    } catch (err) {
      if (songCache.get(key) === placeholder) songCache.set(key, { at: Date.now(), error: err });
      throw err;
    }
  })();
  songCache.set(key, placeholder);
  return placeholder.pending;
}

function dropSongs(userId, ref) {
  songCache.delete(cacheKey(userId, ref));
}

/**
 * A list the user's own browser read from QQ (用户 IP mode), put where a
 * server read would have put it -- so the page, starting a run and matching
 * its captures all use it without this server asking QQ.
 *
 * It describes the user's own account and only ever drives likes into that
 * same account, so it is taken as given (after the route's shape checks),
 * like a list the server read. It replaces whatever was cached for the list,
 * including a server read still in flight (whose result then lands nowhere).
 */
const SUPPLIED_PER_USER = 8;
const supplied = new Map(); // userId -> refs supplied, oldest first
// The list each user's run is aimed at: never the one evicted for browsing,
// or the next capture would read it again from this server's address.
const runRefs = new Map(); // userId -> ref

function noteRunRef(userId, ref) {
  runRefs.set(userId, ref);
  if (runRefs.size > 5000) runRefs.clear();
}

function supplySongs(userId, ref, { title, songs, likedIds, dirId = null, isLikes = false, readMs = 0 }) {
  sweep();
  const key = cacheKey(userId, ref);
  // Bounded per user: a list of 5000 songs costs a few MB here, and clicking
  // through many lists must not pile them all up for the cache's lifetime.
  // Only entries still holding what the browser supplied count (and are ever
  // dropped): one since replaced by a server read, or a read in flight, is
  // left alone -- dropping it would cost that read again.
  const isSupplied = (r) => songCache.get(cacheKey(userId, r))?.supplied === true;
  const mine = (supplied.get(userId) || []).filter((r) => r !== ref && isSupplied(r));
  mine.push(ref);
  const running = runRefs.get(userId);
  while (mine.length > SUPPLIED_PER_USER) {
    const oldest = mine.findIndex((r) => r !== running);
    songCache.delete(cacheKey(userId, mine.splice(oldest, 1)[0]));
  }
  supplied.set(userId, mine);
  if (supplied.size > 5000) supplied.clear();
  if (isLikes || dirId === likes.QQ_LIKES_DIR_ID) favouriteRefs.add(key);
  const liked = new Map();
  const likedSet = new Set(likedIds.map(String));
  for (const s of songs) {
    s.searchText = searchTextFor(s.title, s.artist);
    liked.set(String(s.id), likedSet.has(String(s.id)));
  }
  songCache.set(key, {
    at: Date.now(),
    dirId,
    isLikes: favouriteRefs.has(key),
    title,
    songs,
    liked,
    supplied: true,
  });
  // A like or unlike made while the browser was reading is newer than what
  // it read: replayed on top, as a server read in flight is patched when it
  // lands (setLikedState). The read's own duration bounds which ones, with a
  // margin for the trip back.
  const since = Date.now() - Math.max(0, Math.min(Number(readMs) || 0, 10 * 60 * 1000)) - 5000;
  for (const c of recentLikes.get(userId) || []) {
    if (c.at < since) continue;
    // A whole list unliked at once (取消全部点赞) is one entry.
    if (c.ids) applyManyUnliked(userId, c.ids);
    else setLikedState(userId, c.id, c.liked, { record: false });
  }
  // Captures that arrived while this list was missing (a restart mid-run)
  // are matched now. Not awaited: the page is waiting for the list.
  rematchUnread(userId, ref).catch((err) => console.warn('[platform-tag] rematch failed:', err.message));
  return {
    title,
    total: songs.length,
    songs: songs.map((x) => ({ ...x, alreadyLiked: liked.get(String(x.id)) === true })),
  };
}

/**
 * A like happened (here or by hand on the page): every cached list this user
 * holds now knows, so the heart column and the "already liked" rule agree with
 * the platform without another sweep.
 */
function noteLiked(userId, id) {
  setLikedState(userId, id, true);
}

function noteUnliked(userId, id) {
  setLikedState(userId, id, false);
}

/**
 * Many songs unliked at once (取消全部点赞, done by the user's page): the same
 * patching as noteUnliked, in one pass over the cache rather than one per
 * song -- a 5000-song list per song would be seconds of blocking work.
 */
function noteManyUnliked(userId, ids) {
  const gone = new Set(ids.map(String));
  if (!gone.size) return;
  const now = Date.now();
  const list = (recentLikes.get(userId) || []).filter((c) => now - c.at < RECENT_LIKES_MS);
  // One entry for the whole batch: 300 entries would push the user's other
  // recent likes out of the last 200 the replay keeps.
  list.push({ ids: gone, liked: false, at: now });
  recentLikes.set(userId, list.slice(-200));
  if (recentLikes.size > 5000) recentLikes.clear();
  applyManyUnliked(userId, gone);
}

/** noteManyUnliked's patching, without recording it (also the replay's). */
function applyManyUnliked(userId, gone) {
  const apply = (v) => {
    if (v.liked) for (const id of gone) v.liked.set(id, false);
    // In place, as setLikedState does: whoever holds this array sees it too.
    if (v.isLikes && v.songs) {
      for (let i = v.songs.length - 1; i >= 0; i -= 1) if (gone.has(String(v.songs[i].id))) v.songs.splice(i, 1);
    }
  };
  const prefix = `${userId}|`;
  for (const [k, v] of songCache) {
    if (!k.startsWith(prefix)) continue;
    if (v.pending) v.pending.then(apply, () => {});
    else if (!v.error) apply(v);
  }
}

/**
 * A like or unlike happened. Every cached list of this user is patched in
 * place -- hearts everywhere, and on the favourites list the ROW itself,
 * added or removed -- so neither a run nor the page ever pays a platform
 * read for a click. When the song's row is not on hand (it was liked from a
 * list not in the cache), the favourites entry is marked stale instead: the
 * page's next open re-reads it, while a run keeps using it.
 *
 * A read still in flight is patched when it lands, or the rows it caches
 * would predate the like for the whole TTL.
 */
const recentLikes = new Map(); // userId -> [{ id, liked, at }], the last ten minutes
const RECENT_LIKES_MS = 10 * 60 * 1000;

function setLikedState(userId, id, liked, { record = true } = {}) {
  if (record) {
    const now = Date.now();
    const list = (recentLikes.get(userId) || []).filter((c) => now - c.at < RECENT_LIKES_MS);
    list.push({ id: String(id), liked, at: now });
    recentLikes.set(userId, list.slice(-200));
    if (recentLikes.size > 5000) recentLikes.clear();
  }
  const prefix = `${userId}|`;
  const sid = String(id);
  let song = null;
  for (const [k, v] of songCache) {
    if (k.startsWith(prefix) && v.songs) song = song || v.songs.find((s) => String(s.id) === sid) || null;
  }
  const apply = (v) => {
    if (v.liked) v.liked.set(sid, liked);
    if (!v.isLikes || !v.songs) return;
    const idx = v.songs.findIndex((s) => String(s.id) === sid);
    if (liked && idx < 0) {
      if (song) v.songs.unshift(song);
      else v.stale = true;
    } else if (!liked && idx >= 0) {
      v.songs.splice(idx, 1);
    }
  };
  for (const [k, v] of songCache) {
    if (!k.startsWith(prefix)) continue;
    if (v.pending) v.pending.then(apply, () => {});
    else if (!v.error) apply(v);
  }
}

/**
 * Re-read one list from the platform now, on the user's say-so.
 *
 * The cache exists so a run never asks the platform twice for the same list;
 * this is the one deliberate exception, for when the user has changed their
 * favourites in the platform's own app and wants the page to catch up. A
 * button, not a timer: a timer would be outbound traffic on every open page.
 */
async function refresh(userId, ref, dirId, isLikes = false) {
  // QQ: the page re-reads it itself (lib/qqTagReads) -- never here, and the
  // copy a run uses is not dropped on the way to refusing.
  if (likes.parseRef(ref).platform === 'qq') throw listNotLoaded();
  // A read already in flight is let finish first rather than raced: two
  // reads of the same list at once is the traffic shape this cache exists
  // to prevent, and the one just started is as fresh as this would be.
  const cached = songCache.get(cacheKey(userId, ref));
  if (cached && cached.pending) {
    await cached.pending.catch(() => {});
    return playlistWithLiked(userId, ref, dirId, isLikes);
  }
  dropSongs(userId, ref);
  return playlistWithLiked(userId, ref, dirId, isLikes);
}

/**
 * The list as cached, without reading the platform: null when it is not
 * cached (or only a failure or a read in flight is). Lets the page in 用户 IP
 * mode reuse what is here before reading from the browser again.
 */
function cachedPlaylistWithLiked(userId, ref) {
  sweep();
  const hit = songCache.get(cacheKey(userId, ref));
  if (!hit || hit.error || hit.pending || hit.stale || !hit.songs) return null;
  hit.at = Date.now();
  return {
    title: hit.title,
    total: hit.songs.length,
    songs: hit.songs.map((x) => ({ ...x, alreadyLiked: hit.liked.get(String(x.id)) === true })),
  };
}

/** The list with its liked state, for the page. Same cache the run uses. */
async function playlistWithLiked(userId, ref, dirId, isLikes = false) {
  // QQ: only what the page supplied, as it is -- nothing dropped, nothing read.
  if (likes.parseRef(ref).platform === 'qq') {
    const hit = cachedPlaylistWithLiked(userId, ref);
    if (hit) return hit;
    throw listNotLoaded();
  }
  // A remembered failure is for the capture client, which retries blindly
  // every 2s. A person clicking the list is asking for a fresh attempt -- and
  // has probably just reconnected the account -- so the memory is dropped.
  const cached = songCache.get(cacheKey(userId, ref));
  if (cached && (cached.error || cached.stale)) dropSongs(userId, ref);
  const { title, songs, liked } = await songsFor(userId, ref, dirId, isLikes);
  return {
    title,
    total: songs.length,
    songs: songs.map((x) => ({ ...x, alreadyLiked: liked.get(String(x.id)) === true })),
  };
}

/**
 * Aim the user's open connection at a platform playlist.
 *
 * Reads the playlist first, so an unreadable one (expired login, private list,
 * platform down) fails here — at the button — rather than silently on the
 * first capture. `dirId` is what QQ needs to read "我喜欢"; the page has it
 * from the listing.
 */
async function start({ userId, playlistRef, dirId = null, isLikes = false }) {
  const { ref } = likes.parseRef(playlistRef);

  const session = await prisma.captureSession.findFirst({
    where: { userId, endedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!session) throw new NotFoundError('Capture session');

  // Read at the button, so an unreadable list fails here and not on the first
  // capture. A list the page has just loaded is reused as it is; only a
  // remembered failure is cleared, because pressing 开始 after reconnecting
  // the account is exactly when a retry is wanted. A QQ list is never read
  // here: one the page has not supplied is refused (QQ_LIST_NOT_LOADED) and
  // the page supplies it and asks again.
  const cached = songCache.get(cacheKey(userId, ref));
  if (cached && cached.error) dropSongs(userId, ref);
  // Before the read: a list being read for the run is not evicted meanwhile.
  noteRunRef(userId, ref);
  const list = await songsFor(userId, ref, dirId, isLikes);

  const updated = await prisma.captureSession.update({
    where: { id: session.id },
    data: {
      target: 'platform',
      platformRef: ref,
      // A new run: a title captured in an earlier one is matched afresh.
      platformRunStartedAt: new Date(),
      // Cleared so nothing downstream can read a stale playlist as the
      // destination. mode stays 'playlist': the client scans the 歌 P screens.
      playlistId: null,
      mode: 'playlist',
    },
  });
  // Told to the capture client now rather than on its next heartbeat, when it
  // holds the push channel open (only ever during QQ打标; see apkChannel).
  apkChannel.pushTarget(updated);
  // Every open QQ打标 page learns that a new run began (one started from
  // another browser included), so each shows this run only.
  broadcast(channel(userId), 'platform-tag-run', {
    sessionId: updated.id, playlistRef: ref, runStartedAt: updated.platformRunStartedAt,
  });
  await settleUnread(updated.id, ref).catch(() => {});

  return {
    session: updated,
    playlist: { ref, title: list.title, count: list.songs.length },
  };
}

/**
 * Shape a match candidate for storage and for the page. `alreadyLiked` is
 * filled in only for what the rule below needs to know about.
 */
function toCandidate(c, song, alreadyLiked) {
  return {
    externalId: String(c.songId),
    songType: song ? song.songType : 0,
    title: c.title,
    artist: c.artist,
    kind: c.kind,
    note: c.note || null,
    alreadyLiked: alreadyLiked ?? null,
  };
}

/**
 * One captured title from the client.
 *
 * Outcomes:
 *   liked          exact, single candidate → liked in the platform account
 *   already_liked  exact, single, but it was in 我喜欢 before we looked
 *   pending        one candidate but not exact → needs approval
 *   ambiguous      several candidates → user picks
 *   no_match       nothing in the playlist resembled it
 *   failed         the like was attempted and the platform refused
 *   duplicate      (not stored) this run already saw this title for this list
 */
async function ingest({ session, rawText, singer = null, side = null, row = null }) {
  const text = String(rawText == null ? '' : rawText).slice(0, MAX_TEXT_LENGTH).trim();
  if (!text) throw new ValidationError({ text: ['Text is required'] });
  // Where the title sat on the game's screen (2v2: which team's list, which
  // row), for the panel's red/blue columns. Passed through on this capture's
  // own broadcast only and never stored, as the playlist page does it
  // (captureService.ingestText): it means nothing once the round is over.
  const place = placeOf(side, row);

  // Re-read: the target can move between token resolution and here, and the
  // copy the route holds may name a destination the user has already left.
  const fresh = await prisma.captureSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });
  if (fresh.target !== 'platform' || !fresh.platformRef) {
    // Same refusal shape as the playlist flow: a 409 makes the client
    // un-mark the title and re-send it wherever the user aims next.
    throw new AppError('No capture target', 409);
  }
  const ref = fresh.platformRef;
  const { platform } = likes.parseRef(ref);
  const userId = fresh.userId;
  noteRunRef(userId, ref);

  const existing = await prisma.platformTagEvent.findUnique({
    where: { sessionId_playlistRef_rawText: { sessionId: fresh.id, playlistRef: ref, rawText: text } },
  });
  if (existing) {
    // Seen in an earlier run of this connection and list (停止, then 开始 again):
    // a new run matches it afresh, so the old row gives way (2026-10-06, as
    // the user asked: after 取消全部点赞 and a new run, everything is tagged
    // again). Within one run a title is still matched once. Not while a like
    // is in flight on it (a fresh 'matching' -- checked again in the delete
    // itself, as a retry may take it in between), and only once: two
    // captures of it at once delete it once and race for the new row.
    const runStart = fresh.platformRunStartedAt ? new Date(fresh.platformRunStartedAt) : null;
    const earlierRun = runStart && new Date(existing.createdAt) < runStart
      && (existing.outcome !== 'matching' || staleMatching(existing));
    if (!earlierRun) return { outcome: 'duplicate', eventId: existing.id, rawText: text };
    await prisma.platformTagEvent.deleteMany({
      where: {
        id: existing.id,
        createdAt: { lt: runStart },
        OR: [{ outcome: { not: 'matching' } }, takeableWhere()[1]],
      },
    });
  }

  // 网易云打标 switched off (a run started before): nothing read from or
  // written to NetEase here -- the capture is only recorded.
  if (await neteaseOff(platform)) {
    const held = await claimRow({ fresh, userId, platform, ref, text, outcome: 'pending', error: '网易云打标暂不提供' });
    if (!held.row) return held.payload;
    const payload = { ...toPayload(held.row), ...place };
    broadcast(channel(userId), 'platform-tag-event', payload);
    return payload;
  }

  let songs;
  let liked;
  try {
    ({ songs, liked } = await songsFor(userId, ref));
  } catch (err) {
    if (err.code === 'QQ_LIST_NOT_LOADED') return keepUnread({ fresh, userId, platform, ref, text, singer, place });
    // Told to the page (which can say "reconnect your account") and refused
    // to the client as a temporary failure, so it keeps the title and tries
    // again on its next sweep -- against the cached failure, not the platform.
    // Not the error's own status: a lapsed platform login must never surface
    // as a 401, which the client reads as "pairing revoked".
    // Once per remembered failure, not once per refused title: the client
    // re-sends every title on screen every sweep for as long as this lasts.
    const cached = songCache.get(cacheKey(userId, ref));
    if (!cached || !cached.told) {
      if (cached) cached.told = true;
      broadcast(channel(userId), 'platform-tag-error', {
        sessionId: fresh.id, playlistRef: ref, message: err.message || '读取歌单失败',
      });
    }
    throw new AppError(err.message || '读取歌单失败', 503);
  }
  // The row first, the like after: a like can take seconds (the user's page
  // or phone does it), and a client that gives up waiting re-sends the title
  // -- it then finds the row and gets 'duplicate', never a second like.
  const held = await claimRow({ fresh, userId, platform, ref, text, outcome: 'matching' });
  if (!held.row) return held.payload;
  let event;
  let slowRetry = false;
  try {
    const decided = await decide({ userId, platform, text, songs, liked, singer, session: fresh });
    slowRetry = decided.slowRetry;
    event = await prisma.platformTagEvent.update({
      where: { id: held.row.id },
      data: {
        outcome: decided.outcome,
        candidates: decided.shaped.length ? decided.shaped : undefined,
        likedExternalId: decided.likedExternalId,
        error: decided.error,
      },
    });
  } catch (err) {
    // Never left 'matching' (the panel shows no such row, and a re-send is a
    // duplicate): matched again once the list is next supplied.
    await prisma.platformTagEvent.update({ where: { id: held.row.id }, data: { outcome: 'unread' } }).catch(() => {});
    throw err;
  }

  const payload = { ...toPayload(event), ...place };
  broadcast(channel(userId), 'platform-tag-event', payload);
  if (payload.autoRetry) scheduleAutoRetry(userId, event.id, 0, slowRetry ? TOO_OFTEN_MS : 0);
  return payload;
}

/** side / row as the panel reads them, or nothing for a client that sent neither. */
const MAX_ROW_INDEX = 200;
function placeOf(side, row) {
  const place = {};
  if (side === 'red' || side === 'blue') place.side = side;
  if (Number.isInteger(row) && row >= 0 && row < MAX_ROW_INDEX) place.row = row;
  return place;
}

/**
 * Create this capture's row, or find it is a duplicate: { row } or
 * { payload } (the duplicate answer). Two reads of the same screen racing
 * past the findUnique in ingest end here; the first one wins.
 */
async function claimRow({ fresh, userId, platform, ref, text, outcome, error = null, candidates }) {
  try {
    const row = await prisma.platformTagEvent.create({
      data: { sessionId: fresh.id, userId, platform, playlistRef: ref, rawText: text, outcome, error, candidates },
    });
    return { row };
  } catch (err) {
    if (err.code === 'P2002') {
      const row = await prisma.platformTagEvent.findUnique({
        where: { sessionId_playlistRef_rawText: { sessionId: fresh.id, playlistRef: ref, rawText: text } },
      });
      return { payload: { outcome: 'duplicate', eventId: row?.id ?? null, rawText: text } };
    }
    throw err;
  }
}

/**
 * A capture for a QQ list the server does not hold (a restart since the page
 * supplied it). Kept as 'unread' -- answered to the client as received, so it
 * is not re-sent every sweep -- and the page is asked to read the list again;
 * supplySongs then matches it (rematchUnread).
 */
const NEED_LIST_EVERY_MS = 10 * 1000;
const needListAt = new Map(); // `${userId}|${ref}` -> last time the page was asked

async function keepUnread({ fresh, userId, platform, ref, text, singer = null, place = {} }) {
  // The 歌P singer read with the title rides along, for the rematch's alias step.
  const held = await claimRow({
    fresh, userId, platform, ref, text, outcome: 'unread', candidates: singer ? [{ singer }] : undefined,
  });
  if (!held.row) return held.payload;
  // Asked once per few seconds, not once per capture: a sweep sends a whole
  // screen of titles at once, and each ask is a full list read by the page.
  const key = cacheKey(userId, ref);
  const last = needListAt.get(key) || 0;
  if (Date.now() - last >= NEED_LIST_EVERY_MS) {
    needListAt.set(key, Date.now());
    if (needListAt.size > 5000) needListAt.clear();
    broadcast(channel(userId), 'platform-tag-need-list', { sessionId: fresh.id, playlistRef: ref });
  }
  const payload = { ...toPayload(held.row), ...place };
  broadcast(channel(userId), 'platform-tag-event', payload);
  // The page may have supplied the list while this row was being written:
  // then nothing else would ever match it.
  if (songCache.get(key)?.songs) {
    rematchUnread(userId, ref).catch((err) => console.warn('[platform-tag] rematch failed:', err.message));
  }
  return payload;
}

/**
 * Match the 'unread' captures of the live run on `ref`, now that the list is
 * here. One pass at a time per list (two supplies at once would otherwise
 * like the same song twice), and again once more if asked meanwhile. Each
 * row is taken ('unread' → 'matching') before anything is done with it.
 */
const rematching = new Map(); // `${userId}|${ref}` -> { again }

async function rematchUnread(userId, ref) {
  const key = cacheKey(userId, ref);
  const running = rematching.get(key);
  if (running) { running.again = true; return; }
  const state = { again: false };
  rematching.set(key, state);
  try {
    do {
      state.again = false;
      await rematchPass(userId, ref);
    } while (state.again);
  } finally {
    rematching.delete(key);
  }
}

// A row 'matching' this long was left by a restart (or a crash) mid-like.
const STALE_MATCHING_MS = 60 * 1000;

async function rematchPass(userId, ref) {
  const live = await prisma.captureSession.findMany({
    where: { userId, platformRef: ref, endedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (!live.length) return;
  const rows = await prisma.platformTagEvent.findMany({
    where: {
      sessionId: { in: live.map((x) => x.id) },
      playlistRef: ref,
      OR: [
        { outcome: 'unread' },
        { outcome: 'matching', updatedAt: { lt: new Date(Date.now() - STALE_MATCHING_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  if (!rows.length) return;
  const { platform } = likes.parseRef(ref);
  for (const row of rows) {
    const hit = songCache.get(cacheKey(userId, ref));
    if (!hit || !hit.songs) return;
    const session = await prisma.captureSession.findUnique({ where: { id: row.sessionId } });
    // Only the live run's: an old run's leftovers stay as they were.
    if (!session || session.endedAt || session.platformRef !== ref) continue;
    // Taken only as it was found: 'unread', or 'matching' and still stale (a
    // like in progress refreshes nothing, but a newer pass would have).
    // Compared by age, not equality: the column keeps microseconds.
    const taken = await prisma.platformTagEvent.updateMany({
      where: row.outcome === 'unread'
        ? { id: row.id, outcome: 'unread' }
        : { id: row.id, outcome: 'matching', updatedAt: { lt: new Date(Date.now() - STALE_MATCHING_MS) } },
      data: { outcome: 'matching' },
    });
    if (!taken.count) continue;
    const singer = Array.isArray(row.candidates) && row.candidates[0] && typeof row.candidates[0].singer === 'string'
      ? row.candidates[0].singer : null;
    let updated;
    try {
      const decided = await decide({
        userId, platform, text: row.rawText, songs: hit.songs, liked: hit.liked, singer, session,
      });
      updated = await prisma.platformTagEvent.update({
        where: { id: row.id },
        data: {
          outcome: decided.outcome,
          candidates: decided.shaped.length ? decided.shaped : null,
          likedExternalId: decided.likedExternalId,
          error: decided.error,
        },
      });
    } catch (err) {
      await prisma.platformTagEvent.update({ where: { id: row.id }, data: { outcome: 'unread' } }).catch(() => {});
      throw err;
    }
    const payload = toPayload(updated);
    broadcast(channel(userId), 'platform-tag-event', payload);
    if (payload.autoRetry) scheduleAutoRetry(userId, updated.id, 0, decided.slowRetry ? TOO_OFTEN_MS : 0);
  }
}

/**
 * 'unread' captures of this session left on a list it is no longer aimed at
 * can never be matched: settled, so the page stops waiting for them.
 */
async function settleUnread(sessionId, keepRef = null) {
  const other = keepRef ? { playlistRef: { not: keepRef } } : {};
  // Not a row a retry is liking right now (its error carries the retry
  // prefix): that try finishes it, liked or not.
  const notRetrying = { OR: [{ error: null }, { NOT: { error: { startsWith: apkLikes.NO_EXECUTOR_PREFIX } } }] };
  await prisma.platformTagEvent.updateMany({
    where: { sessionId, outcome: { in: ['unread', 'matching'] }, ...other, ...notRetrying },
    data: { outcome: 'no_match', error: keepRef ? '歌单已切换，没来得及匹配' : '打标已停止，没来得及匹配' },
  });
  // Missed auto-likes of a run that has stopped or moved on are no longer
  // tried on their own: left for the user, and they say so.
  await prisma.platformTagEvent.updateMany({
    where: { sessionId, outcome: 'pending', ...other, error: { startsWith: apkLikes.NO_EXECUTOR_PREFIX } },
    data: { error: STOPPED_RETRY_MSG },
  });
}

/** 网易云打标 switched off: nothing is written to NetEase from here. */
async function neteaseOff(platform) {
  if (platform !== 'netease') return false;
  return !(await settingsService.getNeteaseTagging()).enabled;
}

/**
 * What a capture comes to, against the list: the match, and -- for the one
 * case acted on without asking -- the like, by the user's page or phone.
 */
async function decide({ userId, platform, text, songs, liked, singer, session }) {
  const { outcome: matchOutcome, candidates } = matchTitle(text, songs);
  const byId = new Map(songs.map((s) => [String(s.id), s]));

  let outcome = matchOutcome;
  let slowRetry = false;
  let likedExternalId = null;
  let error = null;
  let shaped = candidates.map((c) => toCandidate(c, byId.get(String(c.songId))));

  // The one case acted on without asking. Mirrors the playlist page's
  // isPerfect(): a single candidate that matched exactly. bracket / punct /
  // ellipsis / loose all wait for a human.
  const perfect = matchOutcome === 'pending' && candidates.length === 1 && candidates[0].kind === 'exact';
  if (perfect) {
    const song = byId.get(String(candidates[0].songId));
    if (liked.get(String(song.id))) {
      // Known from the sweep taken when the run started: nothing to send.
      outcome = 'already_liked';
      likedExternalId = song.id;
      shaped = [toCandidate(candidates[0], song, true)];
    } else if (await neteaseOff(platform)) {
      outcome = 'pending';
      error = '网易云打标暂不提供';
    } else {
      try {
        // knownUnliked: the sweep above has just answered for this id.
        // apkLikes: QQ -- the user's page, else their phone, never this
        // server; NetEase -- the server, as before.
        const res = await apkLikes.like(
          userId, platform,
          { id: song.id, songType: song.songType, knownUnliked: true },
          { purpose: 'auto', session },
        );
        outcome = res.alreadyLiked ? 'already_liked' : 'liked';
        likedExternalId = song.id;
        shaped = [toCandidate(candidates[0], song, true)];
        noteLiked(userId, song.id);
      } catch (err) {
        // Not done this time (page closed or frozen, phone away, a timeout,
        // QQ's 2001): waits in 待确认 and is tried again on its own (autoRetry
        // below). Only a dead login or no QQ account is a failure: trying
        // again cannot help, and the user has to act.
        outcome = err.code === 'NO_USER_IP_EXECUTOR' && !apkLikes.isPermanentFailure(err) ? 'pending' : 'failed';
        error = err.message || String(err);
        slowRetry = apkLikes.saidTooOften(err);
      }
    }
  }

  // 歌手库: a title that matched nothing gets a second try through the site
  // titles an editor attached to it under this game's singer. Only ever
  // offered for approval -- it comes after the auto-like above, which was
  // decided from the title's own match, and its candidates are kind 'alias',
  // which no path treats as safe to like unasked.
  if (matchOutcome === 'no_match' && singer) {
    const siteTitles = await gepSingers.siteTitlesFor(singer, text);
    if (siteTitles.length) {
      const viaAlias = gepSingers.matchSiteTitles({ singer, gameTitle: text, siteTitles, songs });
      if (viaAlias.length) {
        outcome = viaAlias.length === 1 ? 'pending' : 'ambiguous';
        shaped = viaAlias.map((c) => {
          const song = byId.get(String(c.songId));
          return toCandidate(c, song, liked.get(String(c.songId)) === true);
        });
      }
    }
  }
  return { outcome, shaped, likedExternalId, error, slowRetry };
}

/**
 * A QQ capture that matched exactly and would have been liked on the spot,
 * but was not this time (the page in the background, the phone away, a
 * timeout). Tried again on its own -- see autoRetry. Never a capture that
 * needs a human (not exact, several candidates, 歌手库), and never one that
 * failed for good (a dead login is 'failed').
 */
function autoRetryable(e) {
  return e.outcome === 'pending' && missedAutoLike(e);
}

/**
 * Left 'matching' by a restart mid-like (or mid-retry): nobody is working on
 * it any more. Older than STALE_MATCHING_MS, a retry, 点赞 and 忽略 may take it.
 */
function staleMatching(e) {
  return e.outcome === 'matching' && new Date(e.updatedAt).getTime() < Date.now() - STALE_MATCHING_MS;
}

/** The take condition for a row that may be 'pending' or stale 'matching'. */
function takeableWhere() {
  return [
    { outcome: 'pending' },
    { outcome: 'matching', updatedAt: { lt: new Date(Date.now() - STALE_MATCHING_MS) } },
  ];
}

/** autoRetryable's test, whatever the row's outcome is now. */
function missedAutoLike(e) {
  const cands = Array.isArray(e.candidates) ? e.candidates : [];
  return e.platform === 'qq'
    && cands.length === 1
    && cands[0].kind === 'exact'
    && typeof e.error === 'string'
    && e.error.startsWith(apkLikes.NO_EXECUTOR_PREFIX);
}

function toPayload(e) {
  return {
    eventId: e.id,
    sessionId: e.sessionId,
    platform: e.platform,
    playlistRef: e.playlistRef,
    rawText: e.rawText,
    outcome: e.outcome,
    candidates: e.candidates || [],
    likedExternalId: e.likedExternalId,
    error: e.error,
    autoRetry: autoRetryable(e),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

// --- autoRetry: a missed auto-like, tried again from the user's side -------------
//
// The server only dispatches: the like is offered to the user's page or phone
// exactly as the first time (apkLikes.like), never written from here.
//
//   - Only the run the row belongs to, while it is still that run: the
//     connection aimed at this list (a stopped run, or one moved to another
//     list, leaves its rows to the user).
//   - Only when a page in front or the phone is there to take it; a page in
//     the background (frozen on a phone) waits for its return
//     (retryPendingFor, on presence / stream open).
//   - One try at a time per user, and never ahead of a new capture's like:
//     a try waits while the user's like queue is busy.
//   - Each row is taken ('pending' -> 'matching') before anything is done with
//     it, and put back only if it is still 'matching': a timer, the page
//     coming back, 点赞 and 忽略 can never act on it twice.
//   - A try nobody took (unclaimed, nobody there) does not count; after
//     AUTO_RETRY_MAX tries that reached QQ it shows as failed, with why.

let AUTO_RETRY_DELAYS_MS = [3000, 10000, 30000];
// Tries that reached QQ, all triggers together, before it is shown as failed.
let AUTO_RETRY_MAX = 5;
// Timers stop re-arming after this; the page's return still tries.
const AUTO_RETRY_WINDOW_MS = 15 * 60 * 1000;
const retryCounts = new Map(); // eventId -> tries that reached QQ
const retryTimers = new Map(); // eventId -> timer
const retryLane = new Map(); // userId -> Promise: one try at a time per user
const retryingUsers = new Map(); // userId -> { again }

// QQ said "too often" (2001): the next try waits at least this long.
let TOO_OFTEN_MS = 30000;
// A missed auto-like of a run that stopped or moved on (not '没点上：打标网页…',
// so no longer tried on its own).
const STOPPED_RETRY_MSG = '没点上：打标已停止，不再自动重试；需要的话请点「点赞」';

function scheduleAutoRetry(userId, eventId, step = 0, minDelay = 0) {
  if (!AUTO_RETRY_DELAYS_MS.length || retryTimers.has(eventId)) return;
  // The last delay repeats until the cap or the window ends.
  const delay = Math.max(minDelay, AUTO_RETRY_DELAYS_MS[Math.min(step, AUTO_RETRY_DELAYS_MS.length - 1)]);
  const t = setTimeout(() => {
    retryTimers.delete(eventId);
    retryOne(userId, eventId, step).catch((err) => console.warn('[platform-tag] auto-retry failed:', err.message));
  }, delay);
  if (t.unref) t.unref();
  retryTimers.set(eventId, t);
}

/** Is this row's run still the run it was captured in? */
function sameRun(session, row) {
  return Boolean(session && !session.endedAt && new Date(session.expiresAt) > new Date()
    && session.target === 'platform' && session.platformRef === row.playlistRef);
}

/** Wait (briefly) while the user's like queue is busy with a capture. */
async function waitForIdle(userId, maxMs = 20000) {
  const until = Date.now() + maxMs;
  while (apkLikes.queued(userId) && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  return !apkLikes.queued(userId);
}

/** One try at a time per user. */
function inLane(userId, fn) {
  const prev = retryLane.get(userId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  retryLane.set(userId, next);
  next.catch(() => {}).finally(() => { if (retryLane.get(userId) === next) retryLane.delete(userId); });
  return next;
}

/**
 * One more try for one row. Resolves with what came of it: an outcome, or
 * 'skip' (no longer this path's to try), 'nobody' (no page in front, no
 * phone) or 'busy' (a capture's like was queued; tried again later).
 * `step`: the timer it came from (null: the page came back / opened).
 */
function retryOne(userId, eventId, step = null) {
  return inLane(userId, () => retryOneNow(userId, eventId, step));
}

async function retryOneNow(userId, eventId, step) {
  const row = await prisma.platformTagEvent.findUnique({ where: { id: eventId } });
  if (!row || row.userId !== userId || !(autoRetryable(row) || (staleMatching(row) && missedAutoLike(row)))) return 'skip';
  const session = await prisma.captureSession.findUnique({ where: { id: row.sessionId } });
  if (!sameRun(session, row)) return 'skip';
  const old = Date.now() - new Date(row.createdAt).getTime() > AUTO_RETRY_WINDOW_MS;
  const again = (minDelay = 0) => { if (!old) scheduleAutoRetry(userId, eventId, step === null ? 1 : step + 1, minDelay); };
  // A page in the background counts: a desktop one (minimised, or behind the
  // emulator) still likes; a frozen phone one just does not take it, and a
  // try nobody took is not counted.
  if (!(await apkLikes.executorAvailable(userId, 'auto', session))) return 'nobody';
  if (!(await waitForIdle(userId))) { again(); return 'busy'; }
  const taken = await prisma.platformTagEvent.updateMany({
    where: { id: eventId, OR: takeableWhere() },
    data: { outcome: 'matching' },
  });
  if (!taken.count) return 'skip';
  // A capture arrived meanwhile: its like goes first; this row waits.
  if (apkLikes.queued(userId)) {
    await prisma.platformTagEvent.updateMany({ where: { id: eventId, outcome: 'matching' }, data: { outcome: 'pending' } });
    again();
    return 'busy';
  }
  const c = row.candidates[0];
  let data;
  let counted = true;
  let slow = false;
  try {
    // Not knownUnliked: the executor checks first, so a song liked meanwhile
    // (by hand, in QQ's app) is reported as already liked, not written again.
    const res = await apkLikes.like(userId, 'qq', { id: c.externalId, songType: c.songType }, { purpose: 'auto', session });
    data = {
      outcome: res.alreadyLiked ? 'already_liked' : 'liked',
      likedExternalId: String(c.externalId),
      error: null,
      candidates: [{ ...c, alreadyLiked: true }],
    };
  } catch (err) {
    const message = err.message || String(err);
    const permanent = err.code !== 'NO_USER_IP_EXECUTOR' || apkLikes.isPermanentFailure(err);
    // Nobody took it (unclaimed, gone): not a try at all.
    counted = permanent || apkLikes.reachedQq(err);
    const n = (retryCounts.get(eventId) || 0) + (counted ? 1 : 0);
    if (counted) retryCounts.set(eventId, n);
    if (retryCounts.size > 10000) retryCounts.clear();
    slow = apkLikes.saidTooOften(err);
    data = permanent || n >= AUTO_RETRY_MAX
      ? { outcome: 'failed', error: permanent ? message : `自动重试 ${n} 次都没点上，请点「重试」` }
      : { outcome: 'pending', error: message };
    // The run was stopped or moved on while this try ran: left to the user.
    if (data.outcome === 'pending') {
      const now = await prisma.captureSession.findUnique({ where: { id: row.sessionId } }).catch(() => null);
      if (!sameRun(now, row)) data.error = STOPPED_RETRY_MSG;
    }
  }
  // Only if still ours: 忽略 or 点赞 in the meantime is the user's word.
  const written = await prisma.platformTagEvent.updateMany({ where: { id: eventId, outcome: 'matching' }, data })
    .catch(async (err) => {
      await prisma.platformTagEvent.updateMany({ where: { id: eventId, outcome: 'matching' }, data: { outcome: 'pending' } }).catch(() => {});
      throw err;
    });
  if (data.outcome !== 'pending') retryCounts.delete(eventId);
  // On QQ either way: the cached lists learn it even if the row was taken
  // over meanwhile.
  if (data.outcome === 'liked' || data.outcome === 'already_liked') noteLiked(userId, c.externalId);
  if (!written.count) return 'skip';
  const updated = await prisma.platformTagEvent.findUnique({ where: { id: eventId } });
  if (updated) broadcast(channel(userId), 'platform-tag-event', toPayload(updated));
  if (data.outcome === 'pending' && data.error !== STOPPED_RETRY_MSG) again(slow ? TOO_OFTEN_MS : 0);
  return data.outcome;
}

/**
 * Try every waiting auto-like of the user's current run now: the page came
 * to the front, a page or the phone (re)connected. One pass at a time per
 * user, and once more if asked meanwhile; stops when nobody is there.
 */
async function retryPendingFor(userId) {
  const running = retryingUsers.get(userId);
  if (running) { running.again = true; return; }
  const state = { again: false };
  retryingUsers.set(userId, state);
  try {
    do {
      state.again = false;
      const live = await prisma.captureSession.findMany({
        where: { userId, endedAt: null, expiresAt: { gt: new Date() }, target: 'platform', platformRef: { startsWith: 'qq:' } },
        select: { id: true, platformRef: true },
      });
      if (!live.length) return;
      const rows = await prisma.platformTagEvent.findMany({
        where: {
          AND: [
            { OR: live.map((s) => ({ sessionId: s.id, playlistRef: s.platformRef })) },
            { OR: takeableWhere() },
          ],
          platform: 'qq',
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      for (const row of rows) {
        if (!missedAutoLike(row)) continue;
        // Now rather than at its timer.
        const timer = retryTimers.get(row.id);
        if (timer) { clearTimeout(timer); retryTimers.delete(row.id); }
        const r = await retryOne(userId, row.id, null);
        // Nobody there, or captures coming in: the rest wait for their own
        // timers (or the next return) rather than queueing up here.
        if (r === 'nobody' || r === 'busy') return;
      }
    } while (state.again);
  } finally {
    retryingUsers.delete(userId);
  }
}

/**
 * At startup: rows a restart left 'matching' (a like in flight when the old
 * process stopped) are nobody's any more -- the backend is one process, so
 * anything 'matching' from before it started is abandoned. A missed
 * auto-like goes back to 待确认 (tried again when a page or the phone is
 * there); a capture not yet matched goes back to 'unread', matched when the
 * page supplies the list again (it does on reconnecting: the cache is empty).
 */
async function recoverAfterRestart(startedAt = new Date()) {
  const rows = await prisma.platformTagEvent.findMany({
    where: { outcome: 'matching', updatedAt: { lt: startedAt } },
    take: 2000,
  });
  for (const row of rows) {
    let data = { outcome: missedAutoLike(row) ? 'pending' : 'unread' };
    if (data.outcome === 'unread') {
      // Matched only by its own run, on its own list: a run since stopped or
      // moved on would leave it waiting for ever -- settled, as settleUnread does.
      const session = await prisma.captureSession.findUnique({ where: { id: row.sessionId } });
      if (!sameRun(session, row)) data = { outcome: 'no_match', error: '重启时没来得及匹配' };
    }
    await prisma.platformTagEvent.updateMany({
      where: { id: row.id, outcome: 'matching', updatedAt: { lt: startedAt } },
      data,
    });
  }
  return rows.length;
}

/** Ids reach Postgres uuid columns; a malformed one is a 404, not a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownEvent(userId, eventId) {
  if (!UUID_RE.test(String(eventId))) throw new NotFoundError('Event');
  const event = await prisma.platformTagEvent.findUnique({ where: { id: eventId } });
  if (!event || event.userId !== userId) throw new NotFoundError('Event');
  return event;
}

/**
 * Like the chosen candidate for a pending / ambiguous / failed row.
 *
 * `externalId` is required when there are several candidates and optional
 * when there is one. Whatever the user picks, it has to be one of the
 * candidates the match produced — this is not a free-form like.
 */
async function approve({ userId, eventId, externalId, browserResult = null }) {
  const event = await ownEvent(userId, eventId);
  const busy = () => { const e = new AppError('正在自动点赞这首，请稍等', 409); e.code = 'AUTO_RETRY_IN_FLIGHT'; return e; };
  // Being tried again on its own right now; it lands in 已点赞 in a moment.
  if (event.outcome === 'matching' && !staleMatching(event)) throw busy();
  if (!['pending', 'ambiguous', 'failed'].includes(event.outcome) && !staleMatching(event)) {
    throw new AppError('这条已经处理过了（可能在另一个页面）', 409);
  }
  if (await neteaseOff(event.platform)) {
    const e = new AppError('网易云打标暂不提供', 403);
    e.code = 'NETEASE_TAGGING_OFF';
    throw e;
  }
  const cands = event.candidates || [];
  const pick = externalId
    ? cands.find((c) => String(c.externalId) === String(externalId))
    : (cands.length === 1 ? cands[0] : null);
  if (!pick) throw new ValidationError({ externalId: ['请选择一首歌'] });

  let outcome;
  let error = null;
  let failure = null;
  if (event.platform === 'qq') {
    // Written by the page from the user's own address, then reported here:
    // the server never writes to QQ. A page without that ability is old.
    if (!browserResult || typeof browserResult.ok !== 'boolean') {
      const e = new AppError('请刷新页面后再确认（QQ打标改为由你的浏览器点赞）', 409);
      e.code = 'QQ_USER_IP_ONLY';
      throw e;
    }
    if (browserResult.ok) {
      outcome = browserResult.alreadyLiked === true ? 'already_liked' : 'liked';
      noteLiked(userId, pick.externalId);
    } else {
      outcome = 'failed';
      error = String(browserResult.message || 'QQ 未接受').slice(0, 200);
      failure = { statusCode: 502, code: 'QQ_REFUSED' };
    }
  } else {
    try {
      const res = await apkLikes.like(
        userId, event.platform,
        { id: pick.externalId, songType: pick.songType },
        { purpose: 'approve' },
      );
      outcome = res.alreadyLiked ? 'already_liked' : 'liked';
      noteLiked(userId, pick.externalId);
    } catch (err) {
      outcome = 'failed';
      error = err.message || String(err);
      failure = err;
    }
  }

  // Only as found: a retry that took it meanwhile finishes it instead (the
  // like is on QQ either way; its own check sees it as already liked).
  const written = await prisma.platformTagEvent.updateMany({
    where: {
      id: event.id,
      OR: [{ outcome: { in: ['pending', 'ambiguous', 'failed'] } }, takeableWhere()[1]],
    },
    data: {
      outcome,
      error,
      likedExternalId: outcome === 'failed' ? null : pick.externalId,
      candidates: [{ ...pick, alreadyLiked: outcome !== 'failed' }],
    },
  });
  if (!written.count) {
    // Taken meanwhile: by a retry (it finishes it), or by another page.
    const now = await prisma.platformTagEvent.findUnique({ where: { id: event.id } });
    if (now && now.outcome === 'matching') throw busy();
    throw new AppError('这条已经处理过了（可能在另一个页面）', 409);
  }
  const updated = await prisma.platformTagEvent.findUnique({ where: { id: event.id } });
  // byHand: confirmed by the user -- shown amber in every open tab, as the
  // playlist page shows an approval made elsewhere. Only rides the broadcast.
  const payload = { ...toPayload(updated), byHand: true };
  broadcast(channel(userId), 'platform-tag-event', payload);
  if (outcome === 'failed') {
    // The platform's own status and code travel on, so the page can tell
    // "reconnect your account" from "the platform refused this song".
    const e = new AppError(error || '点赞失败', failure?.statusCode || 502);
    if (failure?.code) e.code = failure.code;
    throw e;
  }
  return payload;
}

async function ignore({ userId, eventId }) {
  const event = await ownEvent(userId, eventId);
  if (['liked', 'already_liked'].includes(event.outcome)) {
    throw new AppError('This capture has already been liked', 409);
  }
  // Not while a try is in flight (it may already be liking it on QQ), and
  // only as found: a retry taking it at this moment wins, and says so.
  const busy = () => { const e = new AppError('正在自动点赞这首，请稍等再操作', 409); e.code = 'AUTO_RETRY_IN_FLIGHT'; return e; };
  if (event.outcome === 'matching' && !staleMatching(event)) throw busy();
  const changed = await prisma.platformTagEvent.updateMany({
    where: {
      id: event.id,
      OR: [{ outcome: { notIn: ['liked', 'already_liked', 'matching'] } }, takeableWhere()[1]],
    },
    data: { outcome: 'ignored' },
  });
  if (!changed.count) throw busy();
  const updated = await prisma.platformTagEvent.findUnique({ where: { id: event.id } });
  const payload = toPayload(updated);
  broadcast(channel(userId), 'platform-tag-event', payload);
  return payload;
}

/**
 * What this run has seen so far, oldest first, so a reload or a reconnect
 * shows the same panel the live stream built.
 */
async function getFeed({ userId, sessionId, limit = 300 }) {
  if (!UUID_RE.test(String(sessionId))) throw new NotFoundError('Capture session');
  const session = await prisma.captureSession.findUnique({
    where: { id: sessionId }, select: { userId: true, platformRunStartedAt: true },
  });
  if (!session || session.userId !== userId) throw new NotFoundError('Capture session');
  const rows = await prisma.platformTagEvent.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(Number(limit) || 300, 1), 1000),
  });
  // Where the current run began, for a page that did not start it (another
  // browser): it shows this run only, as the one that did.
  return { events: rows.map(toPayload), runStartedAt: session.platformRunStartedAt || null };
}

/**
 * Stop delivering. The same re-aim to "none" the other pages do, reached
 * through this feature's own gate: /api/capture/target is behind the capture
 * add-on, which a user of this feature need not hold.
 */
async function stop({ userId }) {
  const session = await captureService.setTarget({ userId, target: 'none' });
  if (session) await settleUnread(session.id).catch(() => {});
  // The run is over; lists the server read need not wait for the sweep.
  // Lists the user's browser supplied stay (bounded per user): dropping them
  // would only mean reading them from the browser again on the next start.
  const prefix = `${userId}|`;
  for (const [k, v] of [...songCache.entries()]) if (k.startsWith(prefix) && !v.supplied) songCache.delete(k);
  return { session };
}

module.exports = {
  channel, start, stop, ingest, approve, ignore, getFeed,
  playlistWithLiked, refresh, noteLiked, noteUnliked, noteManyUnliked, supplySongs, cachedPlaylistWithLiked,
  retryPendingFor, recoverAfterRestart,
  // For tests: shorter (or no) retry timers, and a smaller cap.
  _setAutoRetry({ delays, max, tooOften } = {}) {
    if (Array.isArray(delays)) AUTO_RETRY_DELAYS_MS = delays;
    if (Number.isInteger(max)) AUTO_RETRY_MAX = max;
    if (Number.isInteger(tooOften)) TOO_OFTEN_MS = tooOften;
  },
  // For tests: the cache is the one piece of state here.
  dropSongs,
};
