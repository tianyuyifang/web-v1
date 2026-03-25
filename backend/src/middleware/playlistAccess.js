const prisma = require('../db/client');
const { NotFoundError, ForbiddenError } = require('../utils/errors');

/**
 * Middleware that loads a playlist by :id param and checks access rights.
 * Attaches req.playlist and req.playlistAccess to the request.
 *
 * Usage: router.get('/:id', playlistAccess, handler)
 */
async function playlistAccess(req, res, next) {
  try {
    const playlistId = req.params.id;
    const userId = req.user.id;

    // Single query: fetch playlist + user's share/copy permissions
    const playlist = await prisma.playlist.findUnique({
      where: { id: playlistId },
      include: {
        shares: { where: { userId }, select: { id: true }, take: 1 },
        copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
      },
    });

    if (!playlist) {
      return next(new NotFoundError('Playlist'));
    }

    const isOwner = playlist.userId === userId;
    const isShared = playlist.shares.length > 0;
    let canCopy = playlist.copyPermissions.length > 0;

    const canView = isOwner || isShared || canCopy || playlist.isPublic;
    const canEdit = isOwner;

    // Public playlists are always copyable; otherwise need explicit copy permission + view access
    canCopy = playlist.isPublic || (canCopy && canView);

    // Remove shares/copyPermissions from the attached playlist object
    const { shares, copyPermissions, ...cleanPlaylist } = playlist;
    req.playlist = cleanPlaylist;
    req.playlistAccess = { isOwner, isShared, canView, canEdit, canCopy };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Requires view access. Use after playlistAccess middleware.
 */
function requireView(req, res, next) {
  if (!req.playlistAccess.canView) {
    return next(new ForbiddenError());
  }
  next();
}

/**
 * Requires owner access. Use after playlistAccess middleware.
 */
function requireOwner(req, res, next) {
  if (!req.playlistAccess.canEdit) {
    return next(new ForbiddenError());
  }
  next();
}

module.exports = { playlistAccess, requireView, requireOwner };
