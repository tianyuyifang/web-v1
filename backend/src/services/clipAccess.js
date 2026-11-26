const prisma = require('../db/client');

/**
 * Whether this user may use a clip: read its lyrics, add it to a playlist,
 * swap a playlist entry to it.
 *
 * Global clips are offered to everyone (song search, the clip switcher). Any
 * other clip only to its maker, an admin, or someone who can open a playlist
 * it is in. The playlist look-up runs only when it decides — nearly every clip
 * is global.
 *
 * @param {{id: string, isGlobal: boolean, userId: string|null}} clip
 * @param {{id: string, role: string}} user
 */
async function canUseClip(clip, user) {
  if (clip.isGlobal || clip.userId === user.id || user.role === 'ADMIN') return true;
  const userId = user.id;
  const held = await prisma.playlistClip.findFirst({
    where: {
      clipId: clip.id,
      playlist: { OR: [
        { userId },
        { isPublic: true },
        { shares: { some: { userId } } },
        { copyPermissions: { some: { userId } } },
      ] },
    },
    select: { playlistId: true },
  });
  return Boolean(held);
}

module.exports = { canUseClip };
