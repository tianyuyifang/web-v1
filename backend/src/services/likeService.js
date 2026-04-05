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
    liked = true;
  }

  // Broadcast to all SSE clients watching this playlist
  broadcast(playlistId, 'like-update', { clipId, liked });

  return { liked };
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

module.exports = { toggleLike, getPlaylistLikes, getUserLikes, unlikeAllInPlaylist };
