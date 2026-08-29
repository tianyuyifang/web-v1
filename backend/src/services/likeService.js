const prisma = require('../db/client');
const { broadcast } = require('./sseManager');
const { ForbiddenError } = require('../utils/errors');

/**
 * Check if user has non-public view access to a playlist (owner, shared, or copy-permitted).
 * Public-only viewers cannot toggle likes.
 */
async function canToggleLike(userId, playlistId) {
  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: {
      shares: { where: { userId }, select: { id: true }, take: 1 },
      copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
    },
  });
  if (!playlist) return false;
  return playlist.userId === userId || playlist.shares.length > 0 || playlist.copyPermissions.length > 0;
}

/**
 * Note that a song was tagged, for the admin usage view.
 *
 * Only the act of tagging. Untagging writes nothing and cancels nothing: a
 * singer marks the songs they have sung and clears the playlist when the night
 * ends, so counting the surviving likes measured how recently someone tidied
 * up rather than how much they played.
 *
 * Deliberately not awaited and deliberately silent. This is bookkeeping for a
 * page nobody is looking at right now, and a singer mid-game must never have a
 * tag fail — or wait — because of it.
 */
function noteTag(userId, playlistId, clipId, auto) {
  prisma.tagEvent
    .create({ data: { userId, playlistId, clipId, auto } })
    .catch(() => { /* usage stats are not worth failing a tag over */ });
}

/**
 * Shared toggle: one like per (playlistId, clipId).
 * Anyone with non-public access can toggle it on or off for everyone.
 */
async function toggleLike(userId, playlistId, clipId) {
  const allowed = await canToggleLike(userId, playlistId);
  if (!allowed) throw new ForbiddenError('No permission to like clips in this playlist');

  const existing = await prisma.like.findUnique({
    where: { playlistId_clipId: { playlistId, clipId } },
  });

  let liked;
  if (existing) {
    await prisma.like.delete({ where: { id: existing.id } });
    liked = false;
  } else {
    await prisma.like.create({
      data: { userId, playlistId, clipId },
    });
    // On, by hand. The matching delete above records nothing on purpose.
    noteTag(userId, playlistId, clipId, false);
    liked = true;
  }

  // Broadcast to all SSE clients watching this playlist
  broadcast(playlistId, 'like-update', { clipId, liked });

  return { liked };
}

/**
 * Idempotent like — adds a like if absent, never removes one.
 *
 * Automation (screen capture) MUST use this instead of toggleLike. Two
 * reasons, both of which lose data silently:
 *   1. The same song is read many times while it sits on screen, so
 *      toggleLike would flip the like on and off repeatedly.
 *   2. If the user (or anyone else — likes are shared per playlist, not
 *      per user) already liked the clip by hand, toggleLike would UNDO
 *      that. Automation must never revoke a human's like.
 *
 * Returns alreadyLiked so callers can report "no change" without a
 * second query.
 */
async function ensureLiked(userId, playlistId, clipId) {
  const allowed = await canToggleLike(userId, playlistId);
  if (!allowed) throw new ForbiddenError('No permission to like clips in this playlist');

  const existing = await prisma.like.findUnique({
    where: { playlistId_clipId: { playlistId, clipId } },
  });
  if (existing) return { liked: true, alreadyLiked: true };

  try {
    await prisma.like.create({ data: { userId, playlistId, clipId } });
  } catch (err) {
    // P2002 = unique violation: a concurrent request liked it first.
    // The end state is what we wanted, so treat it as success.
    if (err.code === 'P2002') return { liked: true, alreadyLiked: true };
    throw err;
  }
  // On, automatically. Only this branch: the early returns above found the
  // clip already marked, and nothing went from unmarked to marked there.
  noteTag(userId, playlistId, clipId, true);

  broadcast(playlistId, 'like-update', { clipId, liked: true });
  return { liked: true, alreadyLiked: false };
}

/**
 * Get all liked clipIds for a playlist (shared pool).
 */
async function getPlaylistLikes(playlistId) {
  const likes = await prisma.like.findMany({
    where: { playlistId },
    select: { clipId: true },
  });
  return likes.map((l) => `${playlistId}:${l.clipId}`);
}

/**
 * Get all liked clips across all playlists the user can access.
 * Used for initial page load.
 */
async function getUserLikes(userId) {
  const [owned, shared, copyPerm] = await Promise.all([
    prisma.playlist.findMany({ where: { userId }, select: { id: true } }),
    prisma.playlistShare.findMany({ where: { userId }, select: { playlistId: true } }),
    prisma.playlistCopyPermission.findMany({ where: { userId }, select: { playlistId: true } }),
  ]);

  const playlistIds = [
    ...owned.map((p) => p.id),
    ...shared.map((s) => s.playlistId),
    ...copyPerm.map((c) => c.playlistId),
  ];

  const uniqueIds = [...new Set(playlistIds)];

  const likes = await prisma.like.findMany({
    where: { playlistId: { in: uniqueIds } },
    select: { playlistId: true, clipId: true },
  });

  return likes.map((l) => `${l.playlistId}:${l.clipId}`);
}

/**
 * Unlike all clips in a playlist. Broadcasts each removal via SSE.
 */
async function unlikeAllInPlaylist(userId, playlistId) {
  const allowed = await canToggleLike(userId, playlistId);
  if (!allowed) throw new ForbiddenError('No permission');

  const likes = await prisma.like.findMany({
    where: { playlistId },
    select: { clipId: true },
  });

  const result = await prisma.like.deleteMany({
    where: { playlistId },
  });

  for (const l of likes) {
    broadcast(playlistId, 'like-update', { clipId: l.clipId, liked: false });
  }

  return { removed: result.count };
}

module.exports = { toggleLike, ensureLiked, getPlaylistLikes, getUserLikes, unlikeAllInPlaylist };
