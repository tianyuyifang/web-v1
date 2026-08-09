const prisma = require('../db/client');
const { generateToken, generatePairCode, hashToken, isExpired } = require('../utils/captureToken');
const {
  matchTitle, normTitleFolded, splitEllipsis, FOLD_FROM, FOLD_TO,
} = require('./captureMatchService');
const { ensureLiked } = require('./likeService');
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
async function startSession({ userId, playlistId, label, ttlMinutes }) {
  await assertPlaylistAccess(userId, playlistId);

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
          playlistId,
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

/**
 * Ingest one captured string.
 *
 * Nothing is liked here — matching only proposes. The user approves each
 * match by hand via approveEvent.
 */
async function ingestText({ session, rawText }) {
  const text = String(rawText == null ? '' : rawText).slice(0, MAX_TEXT_LENGTH).trim();
  if (!text) throw new ValidationError({ text: ['Text is required'] });

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
  };
  broadcast(session.playlistId, 'capture-event', payload);
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

module.exports = {
  startSession, endSession, resolveSession, redeemPairCode,
  ingestText, approveEvent, ignoreEvent, getReport, getStatus,
  // Exposed for the matching regression script — the prefilter decides which
  // songs the matcher ever sees, so it needs checking against real data.
  fetchCandidateSongs,
};
