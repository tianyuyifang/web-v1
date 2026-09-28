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
const { searchTextFor } = require('../utils/searchText');
const captureService = require('./captureService');
const { broadcast } = require('./sseManager');
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
const songCache = new Map(); // `${userId}|${ref}` -> { at, dirId, title, songs, liked, error }

function cacheKey(userId, ref) {
  return `${userId}|${ref}`;
}

/** Drop entries past their time, so aimed-at lists do not pile up for the life of the process. */
function sweep() {
  const now = Date.now();
  for (const [k, v] of songCache) {
    if (now - v.at > (v.error ? FAIL_TTL_MS : CACHE_TTL_MS)) songCache.delete(k);
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
  const lists = await likes.listPlaylists(userId, platform);
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

async function songsFor(userId, ref, dirId, isLikes = false) {
  sweep();
  const key = cacheKey(userId, ref);
  if (isLikes) favouriteRefs.add(key);
  const hit = songCache.get(key);
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

  const pending = (async () => {
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
      songCache.set(key, entry);
      return entry;
    } catch (err) {
      songCache.set(key, { at: Date.now(), error: err });
      throw err;
    }
  })();
  songCache.set(key, { at: Date.now(), pending });
  return pending;
}

function dropSongs(userId, ref) {
  songCache.delete(cacheKey(userId, ref));
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
function setLikedState(userId, id, liked) {
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
  likes.parseRef(ref);
  dropSongs(userId, ref);
  return playlistWithLiked(userId, ref, dirId, isLikes);
}

/** The list with its liked state, for the page. Same cache the run uses. */
async function playlistWithLiked(userId, ref, dirId, isLikes = false) {
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
  // the account is exactly when a retry is wanted.
  const cached = songCache.get(cacheKey(userId, ref));
  if (cached && cached.error) dropSongs(userId, ref);
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
async function ingest({ session, rawText }) {
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

  const existing = await prisma.platformTagEvent.findUnique({
    where: { sessionId_playlistRef_rawText: { sessionId: fresh.id, playlistRef: ref, rawText: text } },
  });
  if (existing) return { outcome: 'duplicate', eventId: existing.id, rawText: text };

  let songs;
  let liked;
  try {
    ({ songs, liked } = await songsFor(userId, ref));
  } catch (err) {
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
    } else {
      try {
        // knownUnliked: the sweep above has just answered for this id.
        const res = await likes.like(userId, platform, { id: song.id, songType: song.songType, knownUnliked: true });
        outcome = res.alreadyLiked ? 'already_liked' : 'liked';
        likedExternalId = song.id;
        shaped = [toCandidate(candidates[0], song, true)];
        noteLiked(userId, song.id);
      } catch (err) {
        outcome = 'failed';
        error = err.message || String(err);
      }
    }
  }

  let event;
  try {
    event = await prisma.platformTagEvent.create({
      data: {
        sessionId: fresh.id,
        userId,
        platform,
        playlistRef: ref,
        rawText: text,
        outcome,
        candidates: shaped.length ? shaped : undefined,
        likedExternalId,
        error,
      },
    });
  } catch (err) {
    // Two reads of the same screen racing past the findUnique above. The
    // first one won; report it as the duplicate it is.
    if (err.code === 'P2002') {
      const row = await prisma.platformTagEvent.findUnique({
        where: { sessionId_playlistRef_rawText: { sessionId: fresh.id, playlistRef: ref, rawText: text } },
      });
      return { outcome: 'duplicate', eventId: row?.id ?? null, rawText: text };
    }
    throw err;
  }

  const payload = toPayload(event);
  broadcast(channel(userId), 'platform-tag-event', payload);
  return payload;
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
async function approve({ userId, eventId, externalId }) {
  const event = await ownEvent(userId, eventId);
  if (!['pending', 'ambiguous', 'failed'].includes(event.outcome)) {
    throw new AppError('This capture has already been handled', 409);
  }
  const cands = event.candidates || [];
  const pick = externalId
    ? cands.find((c) => String(c.externalId) === String(externalId))
    : (cands.length === 1 ? cands[0] : null);
  if (!pick) throw new ValidationError({ externalId: ['请选择一首歌'] });

  let outcome;
  let error = null;
  let failure = null;
  try {
    const res = await likes.like(userId, event.platform, { id: pick.externalId, songType: pick.songType });
    outcome = res.alreadyLiked ? 'already_liked' : 'liked';
    noteLiked(userId, pick.externalId);
  } catch (err) {
    outcome = 'failed';
    error = err.message || String(err);
    failure = err;
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
  // The run is over; its lists need not wait for the sweep.
  const prefix = `${userId}|`;
  for (const k of [...songCache.keys()]) if (k.startsWith(prefix)) songCache.delete(k);
  return { session };
}

module.exports = {
  channel, start, stop, ingest, approve, ignore, getFeed,
  playlistWithLiked, refresh, noteLiked, noteUnliked,
  // For tests: the cache is the one piece of state here.
  dropSongs,
};
