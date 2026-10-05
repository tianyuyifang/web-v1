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
    if (c.at >= since) setLikedState(userId, c.id, c.liked, { record: false });
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
      // Cleared so nothing downstream can read a stale playlist as the
      // destination. mode stays 'playlist': the client scans the 歌 P screens.
      playlistId: null,
      mode: 'playlist',
    },
  });
  // Told to the capture client now rather than on its next heartbeat, when it
  // holds the push channel open (only ever during QQ打标; see apkChannel).
  apkChannel.pushTarget(updated);
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
async function ingest({ session, rawText, singer = null }) {
  const text = String(rawText == null ? '' : rawText).slice(0, MAX_TEXT_LENGTH).trim();
  if (!text) throw new ValidationError({ text: ['Text is required'] });

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
  if (existing) return { outcome: 'duplicate', eventId: existing.id, rawText: text };

  // 网易云打标 switched off (a run started before): nothing read from or
  // written to NetEase here -- the capture is only recorded.
  if (await neteaseOff(platform)) {
    const held = await claimRow({ fresh, userId, platform, ref, text, outcome: 'pending', error: '网易云打标暂不提供' });
    if (!held.row) return held.payload;
    const payload = toPayload(held.row);
    broadcast(channel(userId), 'platform-tag-event', payload);
    return payload;
  }

  let songs;
  let liked;
  try {
    ({ songs, liked } = await songsFor(userId, ref));
  } catch (err) {
    if (err.code === 'QQ_LIST_NOT_LOADED') return keepUnread({ fresh, userId, platform, ref, text, singer });
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
  try {
    const decided = await decide({ userId, platform, text, songs, liked, singer, session: fresh });
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

  const payload = toPayload(event);
  broadcast(channel(userId), 'platform-tag-event', payload);
  return payload;
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

async function keepUnread({ fresh, userId, platform, ref, text, singer = null }) {
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
  const payload = toPayload(held.row);
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
    broadcast(channel(userId), 'platform-tag-event', toPayload(updated));
  }
}

/**
 * 'unread' captures of this session left on a list it is no longer aimed at
 * can never be matched: settled, so the page stops waiting for them.
 */
async function settleUnread(sessionId, keepRef = null) {
  await prisma.platformTagEvent.updateMany({
    where: { sessionId, outcome: { in: ['unread', 'matching'] }, ...(keepRef ? { playlistRef: { not: keepRef } } : {}) },
    data: { outcome: 'no_match', error: keepRef ? '歌单已切换，没来得及匹配' : '打标已停止，没来得及匹配' },
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
        // Nobody on the user's side could do it (page closed, phone away):
        // left for the user to confirm, with why. One that tried and was
        // refused by QQ is a failure, as before.
        const refused = Array.isArray(err.tried) && err.tried.some((t) => t.endsWith(':failed'));
        outcome = err.code === 'NO_USER_IP_EXECUTOR' && !refused ? 'pending' : 'failed';
        error = err.message || String(err);
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
  return { outcome, shaped, likedExternalId, error };
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
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
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
  if (!['pending', 'ambiguous', 'failed'].includes(event.outcome)) {
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

  const updated = await prisma.platformTagEvent.update({
    where: { id: event.id },
    data: {
      outcome,
      error,
      likedExternalId: outcome === 'failed' ? null : pick.externalId,
      candidates: [{ ...pick, alreadyLiked: outcome !== 'failed' }],
    },
  });
  const payload = toPayload(updated);
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
  const updated = await prisma.platformTagEvent.update({
    where: { id: event.id },
    data: { outcome: 'ignored' },
  });
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
    where: { id: sessionId }, select: { userId: true },
  });
  if (!session || session.userId !== userId) throw new NotFoundError('Capture session');
  const rows = await prisma.platformTagEvent.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(Number(limit) || 300, 1), 1000),
  });
  return { events: rows.map(toPayload) };
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
  playlistWithLiked, refresh, noteLiked, noteUnliked, supplySongs, cachedPlaylistWithLiked,
  // For tests: the cache is the one piece of state here.
  dropSongs,
};
