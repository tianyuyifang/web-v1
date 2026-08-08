const prisma = require('../db/client');
const { generateToken, hashToken, isExpired } = require('../utils/captureToken');
const { matchTitle, normTitle } = require('./captureMatchService');
const { ensureLiked } = require('./likeService');
const { broadcast } = require('./sseManager');
const { NotFoundError, ForbiddenError, ValidationError } = require('../utils/errors');

const DEFAULT_TTL_MINUTES = 4 * 60;
const MAX_TEXT_LENGTH = 200;
const MAX_CANDIDATE_SCAN = 30;

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
 */
async function startSession({ userId, playlistId, label, ttlMinutes }) {
  await assertPlaylistAccess(userId, playlistId);

  const ttl = Number(ttlMinutes) > 0
    ? Math.min(Number(ttlMinutes), 24 * 60)
    : DEFAULT_TTL_MINUTES;

  const token = generateToken();
  const session = await prisma.captureSession.create({
    data: {
      userId,
      playlistId,
      tokenHash: hashToken(token),
      label: label || null,
      expiresAt: new Date(Date.now() + ttl * 60 * 1000),
    },
  });

  return { session, token };
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
 */
async function fetchCandidateSongs(rawText) {
  const n = normTitle(rawText);
  if (!n) return [];
  const stripped = "lower(regexp_replace(title, '[[:space:]《》]', '', 'g'))";
  return prisma.$queryRawUnsafe(
    `SELECT id, title, artist FROM songs
      WHERE ${stripped} LIKE $1 || '%'
         OR $1 LIKE ${stripped} || '%'
      LIMIT ${MAX_CANDIDATE_SCAN}`,
    n
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
  startSession, endSession, resolveSession,
  ingestText, approveEvent, ignoreEvent, getReport,
};
