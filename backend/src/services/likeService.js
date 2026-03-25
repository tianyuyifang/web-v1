const prisma = require('../db/client');

async function toggleLike(userId, playlistId, clipId) {
  const existing = await prisma.like.findUnique({
    where: {
      userId_playlistId_clipId: { userId, playlistId, clipId },
    },
  });

  if (existing) {
    await prisma.like.delete({ where: { id: existing.id } });
    return { liked: false };
  }

  await prisma.like.create({
    data: { userId, playlistId, clipId },
  });
  return { liked: true };
}

async function getUserLikes(userId) {
  const likes = await prisma.like.findMany({
    where: { userId },
    select: { playlistId: true, clipId: true },
  });

  return likes.map((l) => `${l.playlistId}:${l.clipId}`);
}

async function unlikeAllInPlaylist(userId, playlistId) {
  const result = await prisma.like.deleteMany({
    where: { userId, playlistId },
  });
  return { removed: result.count };
}

module.exports = { toggleLike, getUserLikes, unlikeAllInPlaylist };
