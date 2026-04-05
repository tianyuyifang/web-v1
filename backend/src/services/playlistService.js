const prisma = require('../db/client');
const { NotFoundError, ForbiddenError } = require('../utils/errors');
const { toPinyin, toPinyinInitials } = require('../utils/pinyin');
const { searchPlaylists, searchClipsInPlaylist } = require('./searchService');

// ---------------------------------------------------------------------------
// List & Get
// ---------------------------------------------------------------------------

async function getUserPlaylists(userId, query) {
  const playlists = await searchPlaylists(query, userId);

  return playlists.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    isPublic: p.isPublic,
    isOwner: p.userId === userId,
    isShared: p.shares.length > 0,
    canCopy: p.copyPermissions.length > 0,
    ownerName: p.userId !== userId ? p.user.username : undefined,
    clipCount: p._count.playlistClips,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

async function getPlaylistById(playlistId, userId, clipQuery) {
  // If clip search query provided, use filtered results
  let playlistClips;
  if (clipQuery) {
    playlistClips = await searchClipsInPlaylist(playlistId, clipQuery);
  } else {
    playlistClips = await prisma.playlistClip.findMany({
      where: { playlistId },
      orderBy: { position: 'asc' },
      include: {
        clip: {
          include: {
            song: {
              select: {
                id: true,
                title: true,
                artist: true,
                duration: true,
                titlePinyin: true,
                titlePinyinInitials: true,
                titlePinyinConcat: true,
                artistPinyinConcat: true,
              },
            },
          },
        },
      },
    });
  }

  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: {
      shares: {
        include: {
          user: { select: { id: true, username: true } },
        },
      },
      copyPermissions: {
        include: {
          user: { select: { id: true, username: true } },
        },
      },
    },
  });

  if (!playlist) throw new NotFoundError('Playlist');

  const isOwner = playlist.userId === userId;
  const isShared = playlist.shares.some((s) => s.userId === userId);
  const canCopy =
    playlist.isPublic ||
    playlist.copyPermissions.some((cp) => cp.userId === userId);

  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    isPublic: playlist.isPublic,
    isOwner,
    isShared,
    canCopy,
    // Only expose share/copy lists to owner
    ...(isOwner
      ? {
          shares: playlist.shares.map((s) => s.user),
          copyPermissions: playlist.copyPermissions.map((cp) => cp.user),
        }
      : {}),
    clips: playlistClips.map((pc) => ({
      id: pc.id,
      clipId: pc.clip.id,
      position: pc.position,
      speed: pc.speed,
      pitch: pc.pitch,
      colorTag: pc.colorTag,
      comment: pc.comment,
      sectionLabel: pc.sectionLabel,
      clip: {
        id: pc.clip.id,
        start: pc.clip.start,
        length: pc.clip.length,
        lyrics: pc.clip.lyrics,
        song: pc.clip.song,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Create / Update / Delete
// ---------------------------------------------------------------------------

async function createPlaylist(userId, { name, description, isPublic }) {
  const playlist = await prisma.playlist.create({
    data: {
      userId,
      name,
      description,
      isPublic,
      namePinyin: toPinyin(name),
      namePinyinInitials: toPinyinInitials(name),
    },
  });
  return playlist;
}

async function updatePlaylist(playlistId, data) {
  const updateData = {};
  if (data.name !== undefined) {
    updateData.name = data.name;
    updateData.namePinyin = toPinyin(data.name);
    updateData.namePinyinInitials = toPinyinInitials(data.name);
  }
  if (data.description !== undefined) updateData.description = data.description;
  if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;

  return prisma.playlist.update({
    where: { id: playlistId },
    data: updateData,
  });
}

async function deletePlaylist(playlistId) {
  return prisma.playlist.delete({ where: { id: playlistId } });
}

// ---------------------------------------------------------------------------
// Clip management
// ---------------------------------------------------------------------------

async function addClipToPlaylist(playlistId, clipId) {
  // Verify clip exists
  const clip = await prisma.clip.findUnique({ where: { id: clipId } });
  if (!clip) throw new NotFoundError('Clip');

  // Get max position
  const maxPos = await prisma.playlistClip.aggregate({
    where: { playlistId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;

  return prisma.playlistClip.create({
    data: { playlistId, clipId, position },
    include: {
      clip: {
        include: {
          song: {
            select: { id: true, title: true, artist: true, duration: true, filePath: true },
          },
        },
      },
    },
  });
}

async function removeClipFromPlaylist(playlistId, clipId, userId) {
  // Delete shared like for this clip in this playlist (manual cascade)
  await prisma.like.deleteMany({
    where: { playlistId, clipId },
  });

  await prisma.playlistClip.delete({
    where: { playlistId_clipId: { playlistId, clipId } },
  });

  // Re-number remaining clips to close position gaps
  const remaining = await prisma.playlistClip.findMany({
    where: { playlistId },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  if (remaining.length > 0) {
    await prisma.$transaction(
      remaining.map((pc, index) =>
        prisma.playlistClip.update({
          where: { id: pc.id },
          data: { position: index },
        })
      )
    );
  }
}

async function reorderClips(playlistId, clipIds) {
  // Update position for each clip in a transaction
  await prisma.$transaction(
    clipIds.map((clipId, index) =>
      prisma.playlistClip.update({
        where: { playlistId_clipId: { playlistId, clipId } },
        data: { position: index },
      })
    )
  );
}

async function updateClipCustomization(playlistId, clipId, data) {
  const updateData = {};
  if (data.speed !== undefined) updateData.speed = data.speed;
  if (data.pitch !== undefined) updateData.pitch = data.pitch;
  if (data.colorTag !== undefined) updateData.colorTag = data.colorTag;
  if (data.comment !== undefined) updateData.comment = data.comment;
  if (data.sectionLabel !== undefined) updateData.sectionLabel = data.sectionLabel;

  return prisma.playlistClip.update({
    where: { playlistId_clipId: { playlistId, clipId } },
    data: updateData,
  });
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

async function copyPlaylist(playlistId, userId) {
  const original = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: { playlistClips: { orderBy: { position: 'asc' } } },
  });
  if (!original) throw new NotFoundError('Playlist');

  const copied = await prisma.playlist.create({
    data: {
      userId,
      name: `Copy of ${original.name}`,
      description: original.description,
      isPublic: false,
      namePinyin: toPinyin(`Copy of ${original.name}`),
      namePinyinInitials: toPinyinInitials(`Copy of ${original.name}`),
      playlistClips: {
        create: original.playlistClips.map((pc) => ({
          clipId: pc.clipId,
          position: pc.position,
          speed: pc.speed,
          pitch: pc.pitch,
          colorTag: pc.colorTag,
          comment: pc.comment,
          sectionLabel: pc.sectionLabel,
        })),
      },
    },
  });

  return copied;
}

async function batchUpdateClips(playlistId, updates) {
  // updates: [{ clipId, speed?, pitch?, colorTag?, comment? }, ...]
const ops = updates
    .map(({ clipId, ...data }) => {
      const updateData = {};
      if (data.speed !== undefined) updateData.speed = data.speed;
      if (data.pitch !== undefined) updateData.pitch = data.pitch;
      if (data.colorTag !== undefined) updateData.colorTag = data.colorTag;
      if (data.comment !== undefined) updateData.comment = data.comment;
      if (data.sectionLabel !== undefined) updateData.sectionLabel = data.sectionLabel;
      if (Object.keys(updateData).length === 0) return null;
      return prisma.playlistClip.update({
        where: { playlistId_clipId: { playlistId, clipId } },
        data: updateData,
      });
    })
    .filter(Boolean);
  if (ops.length > 0) await prisma.$transaction(ops);
}

async function swapClip(playlistId, oldClipId, newClipId) {
  // Verify new clip exists
  const newClip = await prisma.clip.findUnique({ where: { id: newClipId } });
  if (!newClip) throw new NotFoundError('Clip');

  // Get existing playlist clip to preserve customizations
  const existing = await prisma.playlistClip.findUnique({
    where: { playlistId_clipId: { playlistId, clipId: oldClipId } },
  });
  if (!existing) throw new NotFoundError('PlaylistClip');

  // Swap in a transaction: delete old, create new with same position/customizations
  const [,, created] = await prisma.$transaction([
    prisma.like.deleteMany({ where: { playlistId, clipId: oldClipId } }),
    prisma.playlistClip.delete({
      where: { playlistId_clipId: { playlistId, clipId: oldClipId } },
    }),
    prisma.playlistClip.create({
      data: {
        playlistId,
        clipId: newClipId,
        position: existing.position,
        speed: existing.speed,
        pitch: existing.pitch,
        colorTag: existing.colorTag,
        comment: existing.comment,
        sectionLabel: existing.sectionLabel,
      },
      include: {
        clip: {
          include: {
            song: {
              select: { id: true, title: true, artist: true, duration: true, filePath: true, lyrics: true,
                titlePinyin: true, titlePinyinInitials: true, titlePinyinConcat: true, artistPinyinConcat: true },
            },
          },
        },
      },
    }),
  ]);

  return created;
}

module.exports = {
  getUserPlaylists,
  getPlaylistById,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  addClipToPlaylist,
  removeClipFromPlaylist,
  reorderClips,
  updateClipCustomization,
  batchUpdateClips,
  copyPlaylist,
  swapClip,
};
