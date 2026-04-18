const prisma = require('../db/client');
const { NotFoundError } = require('../utils/errors');

// ---------------------------------------------------------------------------
// Shares (view access)
// ---------------------------------------------------------------------------

async function getShares(playlistId) {
  const shares = await prisma.playlistShare.findMany({
    where: { playlistId },
    include: {
      user: { select: { id: true, username: true } },
    },
  });
  return shares.map((s) => s.user);
}

async function addShare(playlistId, userId) {
  // Verify user exists
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User');

  return prisma.playlistShare.create({
    data: { playlistId, userId },
  });
}

async function removeShare(playlistId, userId) {
  return prisma.playlistShare.delete({
    where: { playlistId_userId: { playlistId, userId } },
  });
}

// ---------------------------------------------------------------------------
// Copy permissions
// ---------------------------------------------------------------------------

async function getCopyPermissions(playlistId) {
  const perms = await prisma.playlistCopyPermission.findMany({
    where: { playlistId },
    include: {
      user: { select: { id: true, username: true } },
    },
  });
  return perms.map((p) => p.user);
}

async function addCopyPermission(playlistId, userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User');

  return prisma.playlistCopyPermission.create({
    data: { playlistId, userId },
  });
}

async function removeCopyPermission(playlistId, userId) {
  return prisma.playlistCopyPermission.delete({
    where: { playlistId_userId: { playlistId, userId } },
  });
}

// ---------------------------------------------------------------------------
// Batch share / copy permissions (across all playlists of an owner)
// ---------------------------------------------------------------------------

async function getBatchShareStatus(ownerId, targetUserId) {
  const playlists = await prisma.playlist.findMany({
    where: { userId: ownerId },
    select: {
      id: true,
      name: true,
      shares: { where: { userId: targetUserId }, select: { id: true }, take: 1 },
      copyPermissions: { where: { userId: targetUserId }, select: { id: true }, take: 1 },
    },
    orderBy: { name: 'asc' },
  });

  return playlists.map((p) => ({
    id: p.id,
    name: p.name,
    isShared: p.shares.length > 0,
    canCopy: p.copyPermissions.length > 0,
  }));
}

async function batchShare(ownerId, targetUserId, { sharePlaylistIds, unsharePlaylistIds, copyPlaylistIds, uncopyPlaylistIds }) {
  // Verify target user exists
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw new NotFoundError('User');

  // Verify all playlist IDs belong to the owner
  const ownerPlaylists = await prisma.playlist.findMany({
    where: { userId: ownerId },
    select: { id: true },
  });
  const ownerIds = new Set(ownerPlaylists.map((p) => p.id));
  const allIds = [...(sharePlaylistIds || []), ...(unsharePlaylistIds || []), ...(copyPlaylistIds || []), ...(uncopyPlaylistIds || [])];
  for (const id of allIds) {
    if (!ownerIds.has(id)) throw new NotFoundError('Playlist');
  }

  const ops = [];

  // Add shares
  if (sharePlaylistIds?.length) {
    ops.push(
      prisma.playlistShare.createMany({
        data: sharePlaylistIds.map((playlistId) => ({ playlistId, userId: targetUserId })),
        skipDuplicates: true,
      })
    );
  }

  // Remove shares
  if (unsharePlaylistIds?.length) {
    ops.push(
      prisma.playlistShare.deleteMany({
        where: { playlistId: { in: unsharePlaylistIds }, userId: targetUserId },
      })
    );
  }

  // Add copy permissions
  if (copyPlaylistIds?.length) {
    ops.push(
      prisma.playlistCopyPermission.createMany({
        data: copyPlaylistIds.map((playlistId) => ({ playlistId, userId: targetUserId })),
        skipDuplicates: true,
      })
    );
  }

  // Remove copy permissions
  if (uncopyPlaylistIds?.length) {
    ops.push(
      prisma.playlistCopyPermission.deleteMany({
        where: { playlistId: { in: uncopyPlaylistIds }, userId: targetUserId },
      })
    );
  }

  if (ops.length) {
    await prisma.$transaction(ops);
  }
}

module.exports = {
  getShares,
  addShare,
  removeShare,
  getCopyPermissions,
  addCopyPermission,
  removeCopyPermission,
  getBatchShareStatus,
  batchShare,
};
