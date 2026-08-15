const prisma = require('../db/client');
const { ForbiddenError } = require('./errors');

/** How many playlists of their own a guest may keep at once. */
const GUEST_PLAYLIST_LIMIT = 3;

/**
 * Throws if the user is a guest already holding the maximum number of
 * playlists. Only lists they own count — ones shared with them do not.
 *
 * Every path that creates a list has to call this: create, copy and merge are
 * three separate writes, and a limit only one of them honours is no limit at
 * all. It lives here rather than in playlistService so mergeService can use it
 * without the two services requiring each other.
 *
 * @param {string} userId
 * @returns {Promise<boolean>} true if the user is a guest
 */
async function assertCanOwnAnotherPlaylist(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (user?.role !== 'GUEST') return false;

  const owned = await prisma.playlist.count({ where: { userId } });
  if (owned >= GUEST_PLAYLIST_LIMIT) {
    throw new ForbiddenError(
      `Guests can have at most ${GUEST_PLAYLIST_LIMIT} playlists`
    );
  }
  return true;
}

module.exports = { GUEST_PLAYLIST_LIMIT, assertCanOwnAnotherPlaylist };
