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

module.exports = {
  getShares,
  addShare,
  removeShare,
  getCopyPermissions,
  addCopyPermission,
  removeCopyPermission,
};
