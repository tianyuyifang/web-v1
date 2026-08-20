const prisma = require('../db/client');
const { generateToken, generatePairCode, hashToken, isExpired } = require('../utils/captureToken');
const {
  matchTitle, normTitleFolded, splitEllipsis, FOLD_FROM, FOLD_TO,
} = require('./captureMatchService');
const { ensureLiked } = require('./likeService');
const { resolveGameSong } = require('./mappingResolveService');
const { broadcast } = require('./sseManager');
const { NotFoundError, ForbiddenError, ValidationError } = require('../utils/errors');

const DEFAULT_TTL_MINUTES = 4 * 60;
const MAX_TEXT_LENGTH = 200;
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
    if (session.userId !== userId) throw new ForbiddenError('Not your capture session');
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

/** Record that the capture client is alive, without ingesting anything. */
async function touchSession(session) {
  await prisma.captureSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
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
  await prisma.captureSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });

  // Dedupe: the same song is read ~15 times while it sits on screen and the
  // string is byte-identical each time.
  const existing = await prisma.captureEvent.findUnique({
    where: { sessionId_rawText: { sessionId: session.id, rawText: text } },
  });
  if (existing) {
    return { outcome: 'duplicate', eventId: existing.id, rawText: text };
  }

  const songs = await fetchCandidateSongs(text);
  const { outcome: matchOutcome, candidates } = matchTitle(text, songs);

  // Annotate each candidate with the clips this playlist actually holds.
  const clips = await clipsInPlaylist(session.playlistId, candidates.map((c) => c.songId));
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
  broadcast(session.playlistId, 'capture-event', payload);
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
function splitTitleArtist(text) {
  const m = /^(.*)[-–—]([^-–—]+)$/.exec(text);
  if (!m) return { title: text, artist: '' };
  const title = m[1].trim();
  const artist = m[2].trim();
  // A leading dash ("-歌手") leaves no title — that is decoration, not a split.
  if (!title || !artist) return { title: text, artist: '' };
  return { title, artist };
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
async function ingestLive({ session, rawText }) {
  const text = String(rawText == null ? '' : rawText).slice(0, MAX_TEXT_LENGTH).trim();
  if (!text) throw new ValidationError({ text: ['Text is required'] });

  await prisma.captureSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });

  // Same dedupe as the playlist flow: a title sits on screen for seconds and
  // is read over and over, byte-identical each time.
  const existing = await prisma.captureEvent.findUnique({
    where: { sessionId_rawText: { sessionId: session.id, rawText: text } },
  });
  if (existing) {
    return {
      outcome: 'duplicate',
      eventId: existing.id,
      rawText: text,
      mapping: existing.candidates || null,
    };
  }

  const { title, artist } = splitTitleArtist(text);

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

  // Must be ensureLiked: it only ever adds. The toggle variant would revoke
  // an existing like, including one a human made by hand.
  const res = await ensureLiked(userId, event.session.playlistId, target);

  const updated = await prisma.captureEvent.update({
    where: { id: eventId },
    data: { outcome: 'approved', matchedClipId: target, resolvedAt: new Date() },
  });

  broadcast(event.session.playlistId, 'capture-resolved', {
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
  broadcast(event.session.playlistId, 'capture-resolved', { eventId, outcome: 'ignored' });
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

  const events = await prisma.captureEvent.findMany({
    where: { sessionId },
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

  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 40;
  const events = await prisma.captureEvent.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take,
  });

  return {
    cards: events.map((e) => {
      const { title, artist } = splitTitleArtist(e.rawText);
      return {
        eventId: e.id,
        rawText: e.rawText,
        title,
        artist,
        outcome: e.outcome,
        mapping: e.candidates || null,
        createdAt: e.createdAt,
      };
    }),
  };
}

module.exports = {
  startSession, endSession, resolveSession, redeemPairCode,
  connect, setTarget,
  ingestText, touchSession, approveEvent, ignoreEvent, getReport, getStatus,
  ingestLive, liveChannel, getLiveFeed,
  // Exposed for tests: the "歌名-歌手" split is a guess that decides whether a
  // mapping is found at all, so it needs checking against real captures.
  splitTitleArtist,
  // Exposed for the matching regression script — the prefilter decides which
  // songs the matcher ever sees, so it needs checking against real data.
  fetchCandidateSongs,
};
