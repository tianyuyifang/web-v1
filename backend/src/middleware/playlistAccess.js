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

    // Single query: fetch playlist + user's share/copy permissions + the
    // owner's role, which decides whether the list can be copied at all.
    const playlist = await prisma.playlist.findUnique({
      where: { id: playlistId },
      include: {
        shares: { where: { userId }, select: { id: true }, take: 1 },
        copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
        user: { select: { role: true } },
      },
    });

    if (!playlist) {
      return next(new NotFoundError('Playlist'));
    }

    const isAdmin = req.user.role === 'ADMIN';
    const isOwner = playlist.userId === userId;
    const isShared = playlist.shares.length > 0;
    let canCopy = playlist.copyPermissions.length > 0;

    // Admins get automatic view + copy access to any playlist (for moderation /
    // copy-to-self), but never edit access — edit stays owner-only below.
    const canView = isOwner || isShared || canCopy || playlist.isPublic || isAdmin;
    const canEdit = isOwner;

    // Owners can always copy their own playlist; public playlists are always copyable;
    // admins can copy any playlist; otherwise need explicit copy permission + view access.
    canCopy = isOwner || playlist.isPublic || isAdmin || (canCopy && canView);

    // …but nothing a guest owns leaves their hands. Otherwise a guest nearing
    // the end of their run could hand a list to a fresh account and start over.
    // The owner and admins are exempt: an owner copying their own list gains
    // nothing, and admins need it for moderation.
    const ownerIsGuest = playlist.user?.role === 'GUEST';
    if (ownerIsGuest && !isOwner && !isAdmin) {
      canCopy = false;
    }

    // Remove shares/copyPermissions/user from the attached playlist object
    const { shares, copyPermissions, user, ...cleanPlaylist } = playlist;
    req.playlist = cleanPlaylist;
    req.playlistAccess = { isOwner, isShared, canView, canEdit, canCopy, ownerIsGuest };

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
