const prisma = require('../db/client');
const songPrefs = require('./songPrefService');
const { generateToken, generatePairCode, hashToken, isExpired } = require('../utils/captureToken');
const {
  matchTitle, normTitleFolded, splitEllipsis, FOLD_FROM, FOLD_TO,
} = require('./captureMatchService');
const { ensureLiked } = require('./likeService');
const { resolveGameSong } = require('./mappingResolveService');
const { titleKey, artistKey } = require('./songKeyService');
const { broadcast } = require('./sseManager');
const { NotFoundError, ForbiddenError, ValidationError } = require('../utils/errors');

const DEFAULT_TTL_MINUTES = 4 * 60;
const MAX_TEXT_LENGTH = 200;
/**
 * Ceiling on a captured lyric passage.
 *
 * The singing screen shows a handful of lines, not a whole song; this is well
 * clear of the longest observed and exists only so a malformed read cannot
 * write an unbounded string.
 */
const MAX_LYRIC_LENGTH = 2000;

/**
 * How far back a 唱卡 capture looks for the row it belongs to.
 *
 * A song sits on screen for seconds and is read many times, so captures have
 * to be deduplicated; the window decides how far back "the same showing"
 * reaches.
 *
 * Two minutes, by decision rather than by derivation. It was aligned to the
 * page's 60s grouping for a while so that "merged" and "same on-screen group"
 * meant the same thing — but a song re-offered between 60s and 2min then
 * opened a second card, and repeats that close together turned out to be rare
 * enough that the extra cards outnumbered the saves. When a repeat inside two
 * minutes IS merged, its card sits in the immediately previous group, one
 * fold away — a cheap find, against duplicate cards appearing routinely.
 *
 * Keying on a round id reported by the client was also built and measured,
 * and does not work: the picking screen is re-read during performances with
 * different contents each time, so one round of five songs produced five
 * different ids. The id is still recorded for future analysis, and ignored
 * here.
 *
 * The failure directions are still not equal: too short shows one song as two
 * cards, too long loses it entirely — and a missing card is a song the singer
 * cannot play. Two minutes stays well under the shortest measured genuine
 * re-sing gap (825s), so nothing real is ever swallowed for good.
 */
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

/**
 * How far back the live page looks.
 *
 * Long enough that an evening survives a reconnection or a night's sleep,
 * short enough that the list stays an account of what was just sung rather
 * than an archive. Rows themselves are kept for thirty days.
 */
const LIVE_FEED_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATE_SCAN = 30;
/**
 * Shortest ellipsis fragment worth filtering on. "一…的约定" leaves "一", which
 * prefix-matches 410 songs and narrows nothing; below this we skip that side.
 */
const MIN_ELLIPSIS_SIDE = 2;
/** Pairing codes are short and guessable, so they live only long enough to type. */
const PAIR_TTL_MS = 5 * 60 * 1000;
/**
 * Upper bound on a candidate-list row index. A round holds ten songs; this is
 * loose enough for a longer mode but keeps a malformed value from making the
 * panel render thousands of empty rows.
 */
const MAX_ROW_INDEX = 200;

/**
 * SSE channel for a live run.
 *
 * The stream manager keys subscriptions by playlist id, and a live session has
 * no playlist — so live runs get their own namespace keyed by user instead.
 * The `live:` prefix keeps it from ever colliding with a playlist UUID, which
 * matters because a collision would leak one user's captures into another
 * user's stream.
 */
/**
 * One string for a (titleKey, artistKey) pair.
 *
 * Both halves are needed -- 致青春/王菲 and 致青春/李宇春 are different songs
 * -- and the separator has to be something neither key can contain, since a
 * key that swallowed it would collide two different songs.
 */
function gameKeyOf(tk, ak) {
  return `${tk || ''}|${ak || ''}`;
}

function liveChannel(userId) {
  return `live:${userId}`;
}

/** The user must be able to like in this playlist to capture into it. */
async function assertPlaylistAccess(userId, playlistId) {
  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: {
      shares: { where: { userId }, select: { id: true }, take: 1 },
      copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
    },
  });
  if (!playlist) throw new NotFoundError('Playlist');
  const allowed =
    playlist.userId === userId || playlist.shares.length > 0 || playlist.copyPermissions.length > 0;
  if (!allowed) throw new ForbiddenError('No permission to capture into this playlist');
  return playlist;
}

/**
 * Start a capture run. The plaintext token is returned exactly once and is
 * not recoverable — only its hash is stored.
 *
 * Any earlier run by this user is ended first. The capture client holds one
 * token from whenever it last paired, so leaving old runs alive meant it kept
 * posting to a playlist the user had moved on from: songs were liked in the
 * wrong playlist — visible to everyone who can see it — while the panel showed
 * a disconnected client, because the session being watched never heard from
 * anyone. One live run per user makes that state unreachable.
 */
async function startSession({ userId, playlistId, label, ttlMinutes, mode }) {
  // A live (唱卡) run has no playlist: titles are read off the game screen and
  // resolved against the mapping table, so there is nothing to like into and
  // nothing to check access on. Anything else keeps the original contract.
  const runMode = mode === 'live' ? 'live' : 'playlist';
  const targetPlaylistId = runMode === 'live' ? null : playlistId;
  if (runMode === 'playlist') await assertPlaylistAccess(userId, playlistId);

  await prisma.captureSession.updateMany({
    where: { userId, endedAt: null, expiresAt: { gt: new Date() } },
    data: { endedAt: new Date() },
  });

  const ttl = Number(ttlMinutes) > 0
    ? Math.min(Number(ttlMinutes), 24 * 60)
    : DEFAULT_TTL_MINUTES;

  const token = generateToken();

  // pairCode is unique, so retry on the rare collision with a live code.
  let session = null;
  for (let attempt = 0; attempt < 5 && !session; attempt++) {
    try {
      session = await prisma.captureSession.create({
        data: {
          userId,
          playlistId: targetPlaylistId,
          mode: runMode,
          // The old path names its destination at creation and never changes
          // it. Without this the column would default to 'none' and every
          // capture from an existing client would be dropped.
          target: runMode,
          tokenHash: hashToken(token),
          pairCode: generatePairCode(),
          pairExpiresAt: new Date(Date.now() + PAIR_TTL_MS),
          label: label || null,
          expiresAt: new Date(Date.now() + ttl * 60 * 1000),
        },
      });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
    }
  }
  if (!session) throw new ValidationError({ pairCode: ['Could not allocate a pairing code'] });

  return { session, token };
}

/**
 * Open a connection without naming a destination.
 *
 * This is the half of the old startSession that lasts: a token, a pairing
 * code, and nothing about where captures go. The destination is set separately
 * and can move as often as the player changes playlists, which is the whole
 * point -- the pairing code gets typed once a game instead of once per
 * playlist.
 *
 * Captures arriving while the target is "none" are dropped on purpose. The
 * user has connected but not yet said what they are doing, and guessing would
 * mean liking songs into whichever playlist was used last.
 */
async function connect({ userId, label, ttlMinutes }) {
  // Still one connection per user. The old reason holds -- a second client
  // posting under a stale token would deliver to the wrong place -- but it now
  // costs the user nothing, because changing destination no longer needs a new
  // connection.
  await prisma.captureSession.updateMany({
    where: { userId, endedAt: null, expiresAt: { gt: new Date() } },
    data: { endedAt: new Date() },
  });

  const ttl = Number(ttlMinutes) > 0
    ? Math.min(Number(ttlMinutes), 24 * 60)
    : DEFAULT_TTL_MINUTES;
  const token = generateToken();

  let session = null;
  for (let attempt = 0; attempt < 5 && !session; attempt++) {
    try {
      session = await prisma.captureSession.create({
        data: {
          userId,
          playlistId: null,
          mode: 'playlist',
          target: 'none',
          tokenHash: hashToken(token),
          pairCode: generatePairCode(),
          pairExpiresAt: new Date(Date.now() + PAIR_TTL_MS),
          label: label || null,
          expiresAt: new Date(Date.now() + ttl * 60 * 1000),
        },
      });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
    }
  }
  if (!session) throw new ValidationError({ pairCode: ['Could not allocate a pairing code'] });

  return { session, token };
}

/**
 * Point an existing connection at a destination, or at nothing.
 *
 * The token is deliberately untouched: the capture client is mid-game with it
 * and must not notice. That is what makes switching playlists free.
 */
async function setTarget({ userId, target, playlistId }) {
  const session = await prisma.captureSession.findFirst({
    where: { userId, endedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!session) throw new NotFoundError('Capture session');

  if (target === 'playlist') {
    // Rejected here rather than left to the access check, which passes the id
    // straight to Prisma and fails as a 500 on a missing one -- a validation
    // problem reported as a server fault.
    if (!playlistId || typeof playlistId !== 'string') {
      throw new ValidationError({ playlistId: ['Playlist is required for this target'] });
    }
    // Checked on every switch, not just at connect: access can be revoked
    // while a connection is open, and this is the point where captures would
    // start landing in the playlist.
    await assertPlaylistAccess(userId, playlistId);
  } else if (target === 'live') {
    // Nothing to check. The session was fetched by userId, so a user can only
    // ever re-aim their own, and 唱卡 writes to no playlist -- there is no
    // access question of the kind the playlist branch above has to answer.
  } else if (target !== 'none') {
    throw new ValidationError({ target: ['Unknown target'] });
  }

  const updated = await prisma.captureSession.update({
    where: { id: session.id },
    data: {
      target,
      // Cleared when not delivering to a playlist, so a stale id can never be
      // read as the destination by anything downstream.
      playlistId: target === 'playlist' ? playlistId : null,
      // Kept in step for the heartbeat, which is how the client learns which
      // screens are worth scanning.
      mode: target === 'live' ? 'live' : 'playlist',
    },
  });

  return updated;
}

/**
 * Exchange a pairing code for the real token.
 *
 * Unauthenticated by design: the code itself is the credential, which is why
 * it is short-lived and single-use. Redeeming clears the code so a second
 * client cannot pair with the same session.
 */
async function redeemPairCode(code) {
  const normalized = String(code == null ? '' : code).trim().toUpperCase();
  if (!normalized) throw new ValidationError({ code: ['Pairing code is required'] });

  const session = await prisma.captureSession.findUnique({ where: { pairCode: normalized } });
  if (!session) throw new NotFoundError('Pairing code');
  if (isExpired(session)) throw new ForbiddenError('Capture session has ended');
  if (!session.pairExpiresAt || session.pairExpiresAt.getTime() <= Date.now()) {
    throw new ForbiddenError('Pairing code has expired');
  }

  // The token is not recoverable from storage (only its hash is kept), so
  // issue a fresh one and repoint the session at it. That also invalidates
  // any token handed out earlier for this session.
  const token = generateToken();
  await prisma.captureSession.update({
    where: { id: session.id },
    data: { tokenHash: hashToken(token), pairCode: null, pairExpiresAt: null },
  });

  return {
    token,
    sessionId: session.id,
    playlistId: session.playlistId,
    expiresAt: session.expiresAt,
  };
}

/** Stop a run. Kills the token immediately, regardless of expiresAt. */
async function endSession({ userId, sessionId }) {
  const session = await prisma.captureSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new NotFoundError('Capture session');
  if (session.userId !== userId) throw new ForbiddenError('Not your capture session');
  if (!session.endedAt) {
    await prisma.captureSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date() },
    });
  }
  return { ended: true };
}

/** Resolve a plaintext token to a live session, or null. */
async function resolveSession(token) {
  if (!token || typeof token !== 'string') return null;
  const session = await prisma.captureSession.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!session || isExpired(session)) return null;
  return session;
}

/**
 * Candidate songs for a captured title.
 *
 * Prefilter in SQL on a normalised prefix in either direction, then let
 * captureMatchService decide. The prefilter is deliberately loose — it only
 * has to avoid scanning 20k rows, not to be correct.
 *
 * The ORDER BY is not cosmetic. A short title like "一" prefix-matches 410
 * rows, and LIMIT without ORDER BY returns whichever rows the scan reached
 * first — so the same capture matched on some runs and not others. Ordering
 * by closeness puts equal titles first, which makes truncation deterministic
 * and means the rows that get cut are always the least plausible ones.
 */
async function fetchCandidateSongs(rawText) {
  const n = normTitleFolded(rawText);
  if (!n) return [];

  // Must fold the same characters normTitleFolded does, or a song the matcher
  // could pair up never reaches it. The fold table is bound as a parameter
  // rather than interpolated — it contains both ' and \.
  const stripped = (from, to) =>
    `lower(translate(regexp_replace(title, '[[:space:]《》]', '', 'g'), $${from}, $${to}))`;

  // An elided capture ("Rolling I...e Deep") is not a prefix of anything, so
  // the plain query below misses it entirely. Match on the two ends instead —
  // each side only when it is long enough to actually narrow the scan.
  const ell = splitEllipsis(rawText);
  if (ell) {
    const pre = normTitleFolded(ell.prefix);
    const suf = normTitleFolded(ell.suffix);
    const params = [FOLD_FROM, FOLD_TO];
    const col = stripped(1, 2);
    const conds = [];
    if (pre.length >= MIN_ELLIPSIS_SIDE) {
      params.push(pre);
      conds.push(`${col} LIKE $${params.length} || '%'`);
    }
    if (suf.length >= MIN_ELLIPSIS_SIDE) {
      params.push(suf);
      conds.push(`${col} LIKE '%' || $${params.length}`);
    }
    // Both ends too short to be selective — fall through rather than scan the
    // whole table for what would be a near-useless candidate list.
    if (conds.length) {
      return prisma.$queryRawUnsafe(
        `SELECT id, title, artist FROM songs
          WHERE ${conds.join(' AND ')}
          ORDER BY length(${col}), ${col}, id
          LIMIT ${MAX_CANDIDATE_SCAN}`,
        ...params
      );
    }
  }

  const col = stripped(1, 2);
  return prisma.$queryRawUnsafe(
    `SELECT id, title, artist FROM songs
      WHERE ${col} LIKE $3 || '%'
         OR $3 LIKE ${col} || '%'
      ORDER BY (${col} = $3) DESC,
               abs(length(${col}) - length($3)),
               ${col},
               id
      LIMIT ${MAX_CANDIDATE_SCAN}`,
    FOLD_FROM, FOLD_TO, n
  );
}

/** Which clips of these songs are actually in the playlist. */
async function clipsInPlaylist(playlistId, songIds) {
  if (!songIds.length) return [];
  // A null playlist would query IS NULL on a non-nullable column: zero rows,
  // no error, and every capture silently recorded as "not in playlist". The
  // caller has no playlist to match against, which is a different answer.
  if (!playlistId) return [];
  const rows = await prisma.playlistClip.findMany({
    where: { playlistId, clip: { songId: { in: songIds } } },
    select: {
      clip: {
        select: {
          id: true, start: true, length: true,
          song: { select: { id: true, title: true, artist: true } },
        },
      },
    },
  });
  return rows.map((r) => r.clip).filter(Boolean);
}

/**
 * Say out loud that a capture was thrown away.
 *
 * Dropping is correct -- a capture with nowhere to go must not be guessed into
 * the last playlist used -- but it was also silent, and that combination cost
 * a user a whole game: the client heartbeated, the site showed connected, and
 * every song was discarded without leaving a trace to find afterwards. The
 * question "where did that round's songs go" had no answer anywhere.
 *
 * Rate-limited per session because a dropped run drops *everything*: a 歌 P
 * screen is re-read every two seconds for as long as it is up, and logging each
 * one would bury the rest of the log in a failure the first line already
 * described.
 */
const noTargetLoggedAt = new Map();
const NO_TARGET_LOG_MS = 60 * 1000;

function logNoTarget(session, text, wanted) {
  const last = noTargetLoggedAt.get(session.id) || 0;
  const now = Date.now();
  if (now - last < NO_TARGET_LOG_MS) return;
  noTargetLoggedAt.set(session.id, now);
  // Bounded: one entry per session, and sessions are created all day.
  if (noTargetLoggedAt.size > 500) noTargetLoggedAt.clear();
  console.warn(
    `[capture] dropped "${text}" — session ${session.id.slice(0, 8)} `
    + `(user ${session.userId.slice(0, 8)}) wants ${wanted}, target is `
    + `${session.target}${session.playlistId ? '' : ' with no playlist'}. `
    + 'Further drops on this session are quiet for 60s.'
  );
}

/** Record that the capture client is alive, without ingesting anything. */
async function touchSession(session, clientVersion) {
  /**
   * Which build is on the other end, when it says so.
   *
   * Written on the heartbeat the client already makes, so it costs no extra
   * request. Only written when a usable number arrives: a build that reports
   * nothing must leave whatever was recorded before rather than blanking it,
   * or reconnecting with an old client would erase the newer answer.
   */
  const version = Number.isInteger(clientVersion) && clientVersion > 0
    ? clientVersion
    : null;

  await prisma.captureSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: new Date(),
      ...(version ? { clientVersion: version } : {}),
    },
  });
  return { ok: true };
}

/**
 * Ingest one captured string.
 *
 * Nothing is liked here — matching only proposes. The user approves each
 * match by hand via approveEvent.
 */
async function ingestText({ session, rawText, side, row }) {
  const text = String(rawText == null ? '' : rawText).slice(0, MAX_TEXT_LENGTH).trim();
  if (!text) throw new ValidationError({ text: ['Text is required'] });

  // Which of the two 2v2 candidate lists this came from. Passed straight
  // through to the panel and not stored: it describes where a title sat on
  // screen at the moment it was read, which is meaningless once the round is
  // over, and persisting it would need a migration for no lasting value.
  const team = side === 'red' || side === 'blue' ? side : null;

  // Position within that list, so the panel can put red row N beside blue
  // row N. Same treatment as `side` — transient, not stored. Clients before v9
  // never send it, and the panel falls back to independent columns.
  const rowIndex =
    Number.isInteger(row) && row >= 0 && row < MAX_ROW_INDEX ? row : null;

  // Mark the client as alive before anything else can fail. Without this the
  // UI cannot tell "emulator not running" from "nothing captured yet" — both
  // show zero rows.
  //
  // Re-read rather than trusting the caller's copy: the target can move
  // between the token being resolved and this running, and the copy would name
  // a playlist the user has already left. update() returns the current row, so
  // this costs nothing extra.
  const fresh = await prisma.captureSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });

  // Aimed elsewhere in the meantime — the capture belongs to whoever the
  // connection points at now, and this is no longer it.
  if (fresh.target !== 'playlist' || !fresh.playlistId) {
    logNoTarget(fresh, text, 'playlist');
    return { outcome: 'no_target', rawText: text };
  }
  const playlistId = fresh.playlistId;

  // Dedupe: the same song is read ~15 times while it sits on screen and the
  // string is byte-identical each time.
  //
  // Scoped to the destination as well as the connection. Keyed on the
  // connection alone, the same song tagged into a second playlist came back
  // "duplicate" and was silently never recorded there.
  const existing = await prisma.captureEvent.findFirst({
    where: { sessionId: session.id, playlistId, rawText: text },
  });
  if (existing) {
    return { outcome: 'duplicate', eventId: existing.id, rawText: text };
  }

  const songs = await fetchCandidateSongs(text);
  const { outcome: matchOutcome, candidates } = matchTitle(text, songs);

  // Annotate each candidate with the clips this playlist actually holds.
  const clips = await clipsInPlaylist(playlistId, candidates.map((c) => c.songId));
  const enriched = candidates.map((c) => {
    const own = clips.filter((cl) => cl.song.id === c.songId)
      .map((cl) => ({ clipId: cl.id, start: cl.start, length: cl.length }))
      .sort((a, b) => a.start - b.start);
    return { ...c, clips: own, inPlaylist: own.length > 0 };
  });

  // A song that matched but has no clip in this playlist is not actionable.
  const actionable = enriched.filter((c) => c.inPlaylist);
  let outcome = matchOutcome;
  if (matchOutcome !== 'no_match' && !actionable.length) outcome = 'not_in_playlist';
  else if (actionable.length > 1) outcome = 'ambiguous';
  else if (actionable.length === 1) {
    outcome = actionable[0].clips.length === 1 ? 'pending' : 'ambiguous';
  }

  const event = await prisma.captureEvent.create({
    data: {
      sessionId: session.id,
      rawText: text,
      // Pinned now, not read from the session later: the connection can be
      // aimed elsewhere before this capture is approved, and the like must
      // still land where it was captured.
      playlistId,
      outcome,
      candidates: enriched.length ? enriched : undefined,
      matchedClipId:
        outcome === 'pending' && actionable[0] ? actionable[0].clips[0].clipId : null,
    },
  });

  const payload = {
    eventId: event.id,
    rawText: text,
    outcome,
    candidates: enriched,
    matchedClipId: event.matchedClipId,
    createdAt: event.createdAt,
    side: team,
    row: rowIndex,
  };
  broadcast(playlistId, 'capture-event', payload);
  return payload;
}

/**
 * Split "歌名-歌手" as the singing screen writes it.
 *
 * The separator also occurs inside real titles ("Lost-你的名字"), so the split
 * is a guess. It is made at the LAST separator because a trailing artist is
 * the reliable half of the pattern: titles carry hyphens far more often than
 * artist names do, so splitting from the right keeps the artist intact and
 * lets a hyphenated title absorb its own dash.
 *
 * When there is no separator at all the whole string is the title. That is a
 * real case (the candidate screen sends title and artist apart, item 3), and
 * an empty artist key still finds a mapping stored with one.
 */
/**
 * Artists whose own name contains a dash, so the split can recognise them.
 *
 * Kept in memory and refreshed lazily. There are 1389 distinct artists in the
 * catalogue and 14 of them carry a dash, so this set is tiny — but it is the
 * only thing that can tell "幸福了然后呢-A-Lin" apart from a title that merely
 * happens to end in "-A".
 */
/**
 * Dashed artist names the game uses that the catalogue does not.
 *
 * Almost every such name is derived from imported_tracks, which is the right
 * source: the artist a platform ships is usually the artist the game names.
 * The dashed_artists table holds the exceptions — the game credits a group
 * where the platform credits the member, so the name never appears in the
 * catalogue to be found.
 *
 * Kept in a table rather than corrected in the catalogue because the importer
 * upserts artist from the platform on every run: an edited row would read
 * correctly until the next import of that playlist and then silently revert,
 * which is the worst shape a fix can have. And in a table rather than in this
 * file because adding one used to mean a deploy.
 *
 * Lowercase, matching how the derived entries are stored.
 */
/**
 * The names that must survive the table being unreadable.
 *
 * These used to be the whole hand-kept list; they live in the database now so
 * that adding one is not a deploy. This is what is left behind: a floor, for
 * the seconds during a deploy when the code is newer than the schema, and for
 * any transient failure of that read. Without it the gazetteer comes back
 * empty and "蠢货-THE9-喻言" splits into "蠢货-THE9" / "喻言" again -- the very
 * bug the list exists to prevent, reappearing exactly when nobody is watching.
 *
 * Deliberately short. Every name here is also a row in dashed_artists, so this
 * is a duplicate of the most load-bearing entries rather than a second list to
 * maintain.
 */
const FALLBACK_DASHED_ARTISTS = ['the9-喻言'];

let dashedArtists = null;
let dashedArtistsAt = 0;
const DASHED_ARTISTS_TTL_MS = 10 * 60 * 1000;

async function loadDashedArtists() {
  const now = Date.now();
  if (dashedArtists && now - dashedArtistsAt < DASHED_ARTISTS_TTL_MS) return dashedArtists;
  const next = new Set(FALLBACK_DASHED_ARTISTS);
  let complete = true;
  try {
    // Read separately from the catalogue query, so one failing does not discard
    // the other. The table can be absent for a few seconds during a deploy --
    // the code ships before `migrate deploy` finishes -- and losing the whole
    // list for that window would silently mis-split every 唱卡 capture in it.
    try {
      const manual = await prisma.dashedArtist.findMany({ select: { name: true } });
      for (const m of manual) {
        const n = String(m.name || '').trim().toLowerCase();
        if (n) next.add(n);
      }
    } catch (err) {
      complete = false;
      console.warn('[capture] hand-added dashed artists unavailable:', err.message);
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT artist FROM imported_tracks
        WHERE artist LIKE '%-%' OR artist LIKE '%–%' OR artist LIKE '%—%'`
    );
    for (const r of rows) {
      const a = String(r.artist || '').trim();
      if (a) next.add(a.toLowerCase());
    }
    // Collaborations are stored joined with "/", and either side can be the
    // one carrying the dash, so each part earns its own entry.
    for (const a of [...next]) {
      for (const part of a.split('/')) {
        const p = part.trim();
        if (p && /[-–—]/.test(p)) next.add(p);
      }
    }
    dashedArtists = next;
    // Only a complete read earns the full cache window. A partial one is kept
    // so the next capture has something to work with, but is not allowed to
    // stand for ten minutes -- the next call retries and repairs it.
    dashedArtistsAt = complete ? now : 0;
  } catch (err) {
    // A failed refresh must not take the split down with it: the last good set
    // keeps working, and a fresh process still has the fallback names below.
    console.warn('[capture] could not refresh dashed-artist list:', err.message);
    if (!dashedArtists) dashedArtists = next;
    dashedArtistsAt = 0;
  }
  return dashedArtists;
}

/**
 * Drop the cached list, so the next read rebuilds it.
 *
 * Called after a name is added or removed. Without this an admin adds the
 * artist that would fix a song, presses 重新解析, and watches nothing happen
 * for up to ten minutes — which reads as the feature being broken rather than
 * as a cache.
 */
function invalidateDashedArtists() {
  dashedArtists = null;
  dashedArtistsAt = 0;
}

/**
 * Split "歌名-歌手" where either half may contain a dash of its own.
 *
 * Splitting at the last dash is right almost always, and wrong in exactly one
 * way: when the artist's own name contains one. "幸福了然后呢-A-Lin" came apart
 * as "幸福了然后呢-A" / "Lin", and every A-Lin song had been failing to map
 * since -- there is not one mapping in the table whose artist holds a dash.
 * Titles with dashes are unaffected either way, because "Non-Stop-周杰伦"
 * splits correctly from the right.
 *
 * So the last dash stays the default, and the catalogue is consulted only for
 * the strings that could be wrong: those with more than one dash. Each earlier
 * dash is tried in turn, longest artist first, and the first candidate that
 * names a known artist wins -- the maximal-munch rule a lexer uses, and what
 * spaCy and gatenlp do for the same ambiguity. Nothing matches, nothing
 * changes: the last-dash answer is returned as before.
 *
 * Synchronous on purpose. The gazetteer is passed in by callers that have
 * awaited it, so this stays usable from places that cannot await -- and with
 * no gazetteer it degrades to precisely the old behaviour.
 */
function splitTitleArtist(text, knownDashedArtists) {
  const m = /^(.*)[-–—]([^-–—]+)$/.exec(text);
  if (!m) return { title: text, artist: '' };
  const title = m[1].trim();
  const artist = m[2].trim();
  // A leading dash ("-歌手") leaves no title — that is decoration, not a split.
  if (!title || !artist) return { title: text, artist: '' };

  // One dash cannot be ambiguous, so most captures never reach the lookup.
  if (knownDashedArtists && knownDashedArtists.size && /[-–—].*[-–—]/.test(text)) {
    // Right to left: the longest artist that matches is the one meant, so
    // "A-Lin" is preferred over "Lin" without needing to rank afterwards.
    for (let i = text.length - 1; i > 0; i--) {
      const ch = text[i];
      if (ch !== '-' && ch !== '–' && ch !== '—') continue;
      const left = text.slice(0, i).trim();
      const right = text.slice(i + 1).trim();
      if (!left || !right) continue;
      if (namesKnownArtist(right, knownDashedArtists)) {
        return { title: left, artist: right };
      }
    }
  }

  return { title, artist };
}

/**
 * Is this string an artist the catalogue knows?
 *
 * Exact match first, because that is what almost every name needs. The rest is
 * for collaborations, where the two sides disagree in ways a string comparison
 * cannot see through:
 *
 *   catalogue: "IN-K/王忻辰"      game: "王忻辰/IN-K"
 *
 * Same two people, opposite order, so "迷失幻境-王忻辰/IN-K" found nothing and
 * split at the dash inside IN-K instead -- title "迷失幻境-王忻辰/IN", artist
 * "K", and a song that is in the catalogue went unmapped.
 *
 * So a collaboration is compared as a set: same members, any order. And a
 * single dashed member is enough on its own, since the whole reason to consult
 * this list is to find where a dash belongs to a name rather than to the split.
 */
function namesKnownArtist(candidate, known) {
  const lower = candidate.toLowerCase();
  if (known.has(lower)) return true;
  if (!lower.includes('/')) return false;

  const parts = lower.split('/').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;

  // Any member whose own name carries the dash settles it: the dash is part of
  // a name, so the split does not belong there.
  if (parts.some((p) => /[-–—]/.test(p) && known.has(p))) return true;

  // Otherwise compare the whole credit order-insensitively.
  const wanted = [...parts].sort().join('/');
  for (const entry of known) {
    if (!entry.includes('/')) continue;
    const e = entry.split('/').map((p) => p.trim()).filter(Boolean).sort().join('/');
    if (e === wanted) return true;
  }
  return false;
}

/**
 * Ingest one captured title in live (唱卡) mode.
 *
 * Where the playlist flow asks "which clip of mine is this", live asks "what
 * can play this at all" — so it resolves against the mapping table instead of
 * the playlist, and nothing is ever liked. A miss is not a failure: it means
 * the song has no approved mapping yet, which is exactly what the review page
 * exists to fill in.
 *
 * Deliberately does NOT call any platform search. Resolution here is a local
 * table lookup only; hitting QQ or NetEase once per captured title is the
 * batch-prefetch pattern that got this machine rate-limited twice (item 53).
 */
/**
 * Longest client-supplied round id we will store.
 *
 * The value is opaque to us — it only ever has to be equal to itself — so the
 * cap is about not letting a client write unbounded text into a column, not
 * about any format we expect.
 */
const BATCH_ID_MAX_LENGTH = 64;

/** A round id we are willing to key on, or null to fall back to the window. */
function cleanBatchId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > BATCH_ID_MAX_LENGTH) return null;
  return trimmed;
}

async function ingestLive({ session, rawText, lyric, stage, batchId }) {
  const text = String(rawText == null ? '' : rawText).slice(0, MAX_TEXT_LENGTH).trim();
  if (!text) throw new ValidationError({ text: ['Text is required'] });

  // Which screen this came from. Clients that predate the field say nothing,
  // and are treated as the picking screen -- that is all they ever read.
  const from = stage === 'singing' ? 'singing' : 'picking';
  // Stored verbatim. The game shuffles lines, masks characters with
  // underscores and misspells words, so cleaning it up here would destroy the
  // evidence needed to reconcile it against real lyrics later.
  const words = lyric == null ? null : String(lyric).slice(0, MAX_LYRIC_LENGTH).trim() || null;

  // Re-read rather than trusting the caller's copy, for the same reason as the
  // playlist flow: the target can move between the token being resolved and
  // this running, and a capture that arrives after the user aimed at a
  // playlist is not a live card.
  const fresh = await prisma.captureSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });
  if (fresh.target !== 'live') {
    logNoTarget(fresh, text, 'live');
    return { outcome: 'no_target', rawText: text };
  }

  // A song picked and then sung is one song, so the performance attaches to
  // the row the picking screen already made rather than starting a second.
  //
  // These used to be separate rows, keyed per stage, because keying on text
  // alone had answered "duplicate" for the performance and thrown away the
  // only copy of the lyrics. Attaching keeps the lyrics and drops the double
  // entry: 唱卡 and the review page each showed the same song twice.
  //
  // Only within the round that picked it. A later round can offer the same
  // song again, and folding those together would put the second round's words
  // on the first round's card -- or, worse, drop the second appearance
  // entirely, which is what used to happen: the lookup was scoped to the whole
  // session, so a song seen in round three never produced a card again for the
  // rest of a four-hour run.
  //
  // Which round a capture belongs to is not something the client reports yet,
  // so the round is approximated by recency -- see DEDUPE_WINDOW_MS.
  // Split before the lookup, not after, because the repeat branch below sends
  // a card to the page and every card has to carry these. Sent without them,
  // an update to a song's lyrics arrived as a card with no title and no
  // artist, and the page -- which replaces a card by id -- rubbed out the
  // name of a song that was already on screen.
  const { title, artist } = splitTitleArtist(text, await loadDashedArtists());

  // A performance prefers a row already marked as sung, and falls back to the
  // The newest row for this song inside the window, whatever stage it is at.
  //
  // A performance used to look for a row already marked 'singing' first, so it
  // would not collide with one a pre-per-stage session had left behind. With
  // the window that preference became a trap: round two's picking makes a new
  // row, but round two's performance skips past it to round one's 'singing' row
  // -- writing this round's words over last round's, and leaving the new card
  // with none at all. Reproduced before this was written.
  //
  // Newest-first is the whole rule now: inside one round, the most recent row
  // for this song is the one this capture belongs to.
  //
  // Always the time window, even from a client that reports a round of its own.
  // Keying on the client's round was built, shipped and measured against real
  // play, and it splits a single round into several: the picking screen is
  // re-read while the songs are being performed and holds different contents
  // each time, so one round of five songs produced five different ids and the
  // same song opened a card under more than one of them. The window is the
  // cruder signal and the correct one, because the page groups on the same
  // signal — see DEDUPE_WINDOW_MS.
  //
  // The reported round is still stored, so the question can be revisited from
  // real data rather than from scratch.
  const batch = cleanBatchId(batchId);
  const scope = { createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) } };

  const existing = await prisma.captureEvent.findFirst({
    where: {
      sessionId: session.id,
      playlistId: null,
      rawText: text,
      ...scope,
      // A performance attaches to whichever row is newest; a picking read only
      // ever matches another picking read. Without that asymmetry the picking
      // screen that opens the next round would attach to the performance that
      // just ended, and the round would never get a card of its own.
      ...(from === 'singing' ? {} : { stage: from }),
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    // A repeat still carries something new when the words have arrived or
    // grown: the game reveals a passage progressively, so a later read of the
    // same song is often a longer one.
    if (words && words.length > (existing.lyric ? existing.lyric.length : 0)) {
      const updated = await prisma.captureEvent.update({
        where: { id: existing.id },
        data: {
          lyric: words,
          // The row was made by the picking screen and is now being sung, so
          // it says so. Without this a card that has words still reads as a
          // song nobody has performed.
          stage: from,
        },
      });
      const payload = {
        eventId: updated.id,
        rawText: text,
        // Carried even though only the words changed: the page replaces a card
        // wholesale by id, so anything left out here is erased from a card the
        // singer is looking at.
        title,
        artist,
        outcome: 'lyric_updated',
        stage: from,
        lyric: words,
        mapping: updated.candidates || null,
        createdAt: updated.createdAt,
      };
      broadcast(liveChannel(session.userId), 'live-card', payload);
      return payload;
    }
    return {
      outcome: 'duplicate',
      eventId: existing.id,
      rawText: text,
      mapping: existing.candidates || null,
    };
  }

  // The full lookup chain: an existing mapping, or a track claimed from the
  // imported pool. Unapproved mappings resolve too — the song plays now and a
  // reviewer confirms it later, because a round lasts seconds and waiting for
  // a human would mean the feature never works when it is needed.
  const { status, mapping, tier, candidates } = await resolveGameSong({ title, artist });

  const resolved = mapping
    ? {
      mappingId: mapping.id,
      source: mapping.source,
      externalId: mapping.externalId,
      title: mapping.platformTitle,
      artist: mapping.platformArtist,
      durationSec: mapping.durationSec,
      // Whether a reviewer has signed this off. The page shows unconfirmed
      // songs differently: they play, but they may be the wrong recording.
      approved: status === 'approved',
      tier: tier || null,
      // Alternatives for the reviewer to switch to, when there were any.
      candidates: candidates && candidates.length > 1 ? candidates : undefined,
    }
    : null;

  const event = await prisma.captureEvent.create({
    data: {
      sessionId: session.id,
      rawText: text,
      stage: from,
      lyric: words,
      // Stored so the next capture in this round can find this row. Without
      // it the lookup above would match nothing and every read would open its
      // own card.
      batchId: batch,
      outcome: resolved ? 'resolved' : 'unmapped',
      candidates: resolved || undefined,
    },
  });

  const payload = {
    eventId: event.id,
    rawText: text,
    // What the split produced, so the page can show the two halves apart and
    // the reviewer can see when the guess went wrong.
    title,
    artist,
    stage: from,
    lyric: words,
    outcome: event.outcome,
    mapping: resolved,
    createdAt: event.createdAt,
  };
  broadcast(liveChannel(session.userId), 'live-card', payload);
  return payload;
}

/** Approve a proposed match: apply the like. Idempotent by construction. */
async function approveEvent({ userId, eventId, clipId }) {
  const event = await prisma.captureEvent.findUnique({
    where: { id: eventId },
    include: { session: true },
  });
  if (!event) throw new NotFoundError('Capture event');
  if (event.session.userId !== userId) throw new ForbiddenError('Not your capture session');

  const target = clipId || event.matchedClipId;
  if (!target) throw new ValidationError({ clipId: ['No clip to approve'] });

  // The event's own playlist, never the session's. The session says where
  // captures go now; this says where this one came from, and approving after
  // the connection moved must not like the song into the new destination.
  // Older rows predate the column and fall back to the session, which for them
  // cannot have moved.
  const destination = event.playlistId || event.session.playlistId;
  if (!destination) {
    throw new ValidationError({ playlistId: ['This capture has no playlist to like into'] });
  }

  // Must be ensureLiked: it only ever adds. The toggle variant would revoke
  // an existing like, including one a human made by hand.
  const res = await ensureLiked(userId, destination, target);

  const updated = await prisma.captureEvent.update({
    where: { id: eventId },
    data: { outcome: 'approved', matchedClipId: target, resolvedAt: new Date() },
  });

  broadcast(destination, 'capture-resolved', {
    eventId, outcome: 'approved', clipId: target,
  });
  return { outcome: 'approved', clipId: target, alreadyLiked: res.alreadyLiked, event: updated };
}

/** Dismiss a proposal without liking anything. */
async function ignoreEvent({ userId, eventId }) {
  const event = await prisma.captureEvent.findUnique({
    where: { id: eventId },
    include: { session: true },
  });
  if (!event) throw new NotFoundError('Capture event');
  if (event.session.userId !== userId) throw new ForbiddenError('Not your capture session');

  await prisma.captureEvent.update({
    where: { id: eventId },
    data: { outcome: 'ignored', resolvedAt: new Date() },
  });
  // Same reasoning as approve: the row it is displayed in belongs to the
  // playlist it was captured for, not to wherever the connection points now.
  broadcast(event.playlistId || event.session.playlistId, 'capture-resolved',
    { eventId, outcome: 'ignored' });
  return { outcome: 'ignored' };
}

/**
 * Lightweight liveness check for the panel to poll.
 *
 * Distinguishes the three states that all look like "zero rows" otherwise:
 *   waiting      the client has never posted — emulator or APK not running,
 *                or the token was never entered
 *   connected    posted recently
 *   stale        posted before, but not lately — client died or the game
 *                left the song list
 */
async function getStatus({ userId, sessionId }) {
  const session = await prisma.captureSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new NotFoundError('Capture session');
  if (session.userId !== userId) throw new ForbiddenError('Not your capture session');

  const STALE_AFTER_MS = 60 * 1000;
  let client = 'waiting';
  if (session.lastSeenAt) {
    const age = Date.now() - new Date(session.lastSeenAt).getTime();
    client = age <= STALE_AFTER_MS ? 'connected' : 'stale';
  }

  return {
    client,
    lastSeenAt: session.lastSeenAt,
    ended: Boolean(session.endedAt),
    expiresAt: session.expiresAt,
    // Liveness alone is no longer the whole answer: a connection can be alive
    // and pointed somewhere else entirely, which a panel would otherwise show
    // as a healthy run that never receives anything.
    target: session.target,
    playlistId: session.playlistId,
  };
}

/**
 * The user's current connection, whatever it is pointing at.
 *
 * Keyed on the user rather than a session id because the caller is the nav
 * bar, which is on every page and has no run in mind: the question it asks is
 * "am I connected, and where is it going", not "how is session X doing".
 *
 * Returns null rather than throwing when there is nothing — being
 * disconnected is the ordinary state, not an error.
 */
async function getConnection(userId) {
  const session = await prisma.captureSession.findFirst({
    where: { userId, endedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    include: { playlist: { select: { id: true, name: true } } },
  });
  if (!session) return null;

  const STALE_AFTER_MS = 60 * 1000;
  let client = 'waiting';
  if (session.lastSeenAt) {
    const age = Date.now() - new Date(session.lastSeenAt).getTime();
    client = age <= STALE_AFTER_MS ? 'connected' : 'stale';
  }

  return {
    sessionId: session.id,
    client,
    target: session.target,
    playlist: session.playlist || null,
    lastSeenAt: session.lastSeenAt,
    // Which build is connected, or null from anything that predates reporting
    // it. The route compares it against the current one — the version numbers
    // live there, and a service that reached for them would be reading its own
    // caller's configuration.
    clientVersion: session.clientVersion ?? null,
    expiresAt: session.expiresAt,
    // Only while it is still redeemable — a spent or stale code on screen is
    // worse than none, since it is indistinguishable from a working one.
    pairCode: session.pairCode && session.pairExpiresAt
      && session.pairExpiresAt.getTime() > Date.now()
      ? session.pairCode : null,
    pairExpiresAt: session.pairExpiresAt,
  };
}

/**
 * Everything captured in this run, plus the unmatched list.
 * Unmatched is per session by design — it answers "what did this run miss".
 */
async function getReport({ userId, sessionId }) {
  const session = await prisma.captureSession.findUnique({
    where: { id: sessionId },
    include: { playlist: { select: { id: true, name: true } } },
  });
  if (!session) throw new NotFoundError('Capture session');
  if (session.userId !== userId) throw new ForbiddenError('Not your capture session');

  // Scoped to the playlist this report is about. A connection now spans
  // several playlists, so filtering on the session alone hands a panel the
  // captures made for other lists -- which it then shows as its own receipts
  // and, worse, feeds to auto-approve.
  const events = await prisma.captureEvent.findMany({
    where: { sessionId, playlistId: session.playlistId },
    orderBy: { createdAt: 'desc' },
  });

  const summary = events.reduce((acc, e) => {
    acc[e.outcome] = (acc[e.outcome] || 0) + 1;
    return acc;
  }, {});
  summary.total = events.length;

  const unmatched = events
    .filter((e) => e.outcome === 'no_match' || e.outcome === 'not_in_playlist')
    .map((e) => ({ rawText: e.rawText, outcome: e.outcome, at: e.createdAt }));

  return { session, events, summary, unmatched };
}

/**
 * Recent cards for a live run.
 *
 * This is what makes the missing SSE `id:` field harmless (item 15): the page
 * refetches on reconnect and gets whatever it missed, because the events are
 * in the database rather than only on the wire.
 */
async function getLiveFeed({ userId, sessionId, limit }) {
  const session = await prisma.captureSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new NotFoundError('Capture session');
  if (session.userId !== userId) throw new ForbiddenError('Not your capture session');

  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 60;

  // The singer's last day, not this connection's.
  //
  // Keyed on the session, the feed emptied whenever a connection was replaced
  // -- which happens when the client reconnects, when the four-hour token
  // expires, or when someone presses stop and starts again. The cards were
  // still in the database; they had simply stopped being reachable, and from
  // the singer's side an evening in one room had become several.
  //
  // A day is the span that matches how the page is used: an evening's singing,
  // still there the next morning, gone by the following night. Measured before
  // choosing it -- the busiest account produced 553 cards in 24 hours across
  // two sessions, and this query answers in 2.9ms.
  const since = new Date(Date.now() - LIVE_FEED_WINDOW_MS);

  // Live captures only. The same connection may have tagged playlists earlier,
  // and those events carry a different shape -- `candidates` is an array of
  // songs there and a single mapping object here -- so mixing them renders
  // cards for songs that were never live captures at all.
  const events = await prisma.captureEvent.findMany({
    where: {
      playlistId: null,
      createdAt: { gte: since },
      // Every live session this account has had in the window. Scoped by
      // userId rather than by the id passed in, which is what widens it --
      // and the ownership check above is what keeps that safe.
      session: { userId, mode: 'live' },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });

  // Fetched once for the whole page rather than per card, and before the map,
  // which cannot await.
  const known = await loadDashedArtists();

  // Whether a mapping has been confirmed, as it stands now.
  //
  // The card carries a copy of the match made when the song was captured, and
  // that copy records whether it was confirmed at that moment -- a fact which
  // stops being true the moment someone confirms it. Reloading the page showed
  // a song the singer had just confirmed as still awaiting confirmation, and
  // 24 of 300 stored matches were already stale this way.
  //
  // One query for the whole page rather than one per card.
  //
  // The whole row is read, not just `approved`, because a mapping can now be
  // repointed or deleted outright -- 不是这首 removes the recording from the
  // catalogue. A snapshot that survived that describes a track which no longer
  // exists, so the card offered a version that had been deleted and failed on
  // play. Where the mapping is gone the card reports unconfigured, which is
  // what it is; where it still exists the current target wins over the
  // captured one.
  const mappingIds = [...new Set(
    events.map((e) => e.candidates && e.candidates.mappingId).filter(Boolean)
  )];
  const MAPPING_FIELDS = {
    id: true,
    approved: true,
    source: true,
    externalId: true,
    platformTitle: true,
    platformArtist: true,
    durationSec: true,
    titleKey: true,
    artistKey: true,
  };

  const currentById = new Map();
  if (mappingIds.length) {
    const rows = await prisma.songMapping.findMany({
      where: { id: { in: mappingIds } },
      select: MAPPING_FIELDS,
    });
    for (const r of rows) currentById.set(r.id, r);
  }

  // A rejected song is re-resolved into a NEW mapping row, so the id on the
  // snapshot names something that no longer exists while the game song itself
  // is mapped again. Look those up by the game-side key instead of reporting
  // the card as unconfigured when a perfectly good replacement is waiting.
  const orphaned = events.filter((e) => {
    const id = e.candidates && e.candidates.mappingId;
    return id && !currentById.has(id);
  });
  const byGameKey = new Map();
  if (orphaned.length) {
    const keys = orphaned.map((e) => {
      const { title, artist } = splitTitleArtist(e.rawText, known);
      return { titleKey: titleKey(title), artistKey: artistKey(artist) };
    }).filter((k) => k.titleKey);
    if (keys.length) {
      const rows = await prisma.songMapping.findMany({
        where: { OR: keys },
        select: MAPPING_FIELDS,
      });
      for (const r of rows) byGameKey.set(gameKeyOf(r.titleKey, r.artistKey), r);
    }
  }

  const cards = events.map((e) => {
    const { title, artist } = splitTitleArtist(e.rawText, known);
    let mapping = e.candidates || null;
    if (mapping && mapping.mappingId) {
      const now = currentById.get(mapping.mappingId)
        || byGameKey.get(gameKeyOf(titleKey(title), artistKey(artist)));
      if (!now) {
        // Nothing maps this song any more. The event still records what the
        // game showed -- that stays true -- but there is nothing to play.
        mapping = null;
      } else {
        mapping = {
          ...mapping,
          mappingId: now.id,
          approved: now.approved,
          source: now.source,
          externalId: now.externalId,
          title: now.platformTitle ?? mapping.title,
          artist: now.platformArtist ?? mapping.artist,
          durationSec: now.durationSec ?? mapping.durationSec,
          // The stored alternatives were computed against a pool that has
          // since changed; the page refetches them when the card is opened.
          candidates: undefined,
        };
      }
    }
    return {
      eventId: e.id,
      rawText: e.rawText,
      title,
      artist,
      stage: e.stage || 'picking',
      lyric: e.lyric || null,
      outcome: e.outcome,
      mapping,
      createdAt: e.createdAt,
    };
  });

  // What this singer has settled on for the recordings now on screen: the key
  // they sing them in, the tempo, a note, colour flags.
  //
  // Attached after the cards are built, because a card's recording is only
  // known once the mapping above has been re-resolved -- a repointed mapping
  // means the preference wanted belongs to the track playing now, not the one
  // captured then.
  //
  // One query for the whole page, in keeping with the two lookups above.
  // Failure is swallowed: preferences are a convenience, and a card that plays
  // in its original key is far better than a page that does not load. The
  // absent field reads as "nothing remembered", which is also what the page
  // shows before anyone has set anything.
  // The singer's global default rides along in the same lookup rather than
  // costing a request of its own -- measured at 0.081 ms over the query that
  // was happening anyway, against 0.891 ms for asking separately.
  let prefs = new Map();
  try {
    prefs = await songPrefs.getMany(userId, [
      ...cards
        .filter((c) => c.mapping && c.mapping.source && c.mapping.externalId)
        .map((c) => ({ source: c.mapping.source, externalId: c.mapping.externalId })),
      { source: songPrefs.DEFAULT_SOURCE, externalId: songPrefs.DEFAULT_EXTERNAL_ID },
    ]);
  } catch (err) {
    console.warn('[capture] song preferences unavailable for this feed:', err.message);
  }

  // Pulled out of the map so a card never carries it as if it were its own.
  const defaults = prefs.get(songPrefs.DEFAULT_KEY) || null;

  return {
    cards: cards.map((c) => (c.mapping
      ? { ...c, prefs: prefs.get(`${c.mapping.source}:${c.mapping.externalId}`) || null }
      : c)),
    // Only pitch and speed: the sentinel row describes the singer, not a song,
    // so a note or a colour on it would mean nothing.
    defaults: defaults ? { pitch: defaults.pitch, speed: defaults.speed } : null,
  };
}

module.exports = {
  startSession, endSession, resolveSession, redeemPairCode,
  connect, setTarget, getConnection,
  ingestText, touchSession, approveEvent, ignoreEvent, getReport, getStatus,
  // The route drops "aimed at nothing" before the service sees it, and that
  // drop needs saying out loud just as much as the ones in here.
  logNoTarget,
  ingestLive, liveChannel, getLiveFeed,
  // Exposed for tests: the "歌名-歌手" split is a guess that decides whether a
  // mapping is found at all, so it needs checking against real captures.
  splitTitleArtist,
  // The unconfigured queue splits captures itself, and the artist editor has
  // to be able to clear what it changed.
  loadDashedArtists, invalidateDashedArtists,
  // Exposed for the matching regression script — the prefilter decides which
  // songs the matcher ever sees, so it needs checking against real data.
  fetchCandidateSongs,
};
