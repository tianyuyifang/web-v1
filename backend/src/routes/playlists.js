const router = require('express').Router();
const crypto = require('crypto');
const validate = require('../middleware/validate');
const { playlistAccess, requireView, requireOwner } = require('../middleware/playlistAccess');
const {
  createPlaylistSchema,
  updatePlaylistSchema,
  addClipSchema,
  reorderClipsSchema,
  updateClipCustomizationSchema,
  shareSchema,
} = require('../validators/playlists');
const playlistService = require('../services/playlistService');
const shareService = require('../services/shareService');
const { ForbiddenError } = require('../utils/errors');

// ========================= Playlist CRUD =========================

// GET /api/playlists — list own + shared + public playlists
router.get('/', async (req, res, next) => {
  try {
    const playlists = await playlistService.getUserPlaylists(
      req.user.id,
      req.query.q || ''
    );
    res.json({ playlists });
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists — create playlist
router.post('/', validate(createPlaylistSchema), async (req, res, next) => {
  try {
    const playlist = await playlistService.createPlaylist(req.user.id, req.validated);
    res.status(201).json(playlist);
  } catch (err) {
    next(err);
  }
});

// ========================= Batch Share =========================

// GET /api/playlists/batch-share-status?userId=xxx — get share/copy status for all my playlists with a target user
router.get('/batch-share-status', async (req, res, next) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: { message: 'userId query param is required' } });
    }
    const status = await shareService.getBatchShareStatus(req.user.id, userId);
    res.json({ playlists: status });
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/batch-share — batch add/remove shares and copy permissions
router.post('/batch-share', async (req, res, next) => {
  try {
    const { userId, sharePlaylistIds, unsharePlaylistIds, copyPlaylistIds, uncopyPlaylistIds } = req.body;
    if (!userId) {
      return res.status(400).json({ error: { message: 'userId is required' } });
    }
    await shareService.batchShare(req.user.id, userId, {
      sharePlaylistIds: sharePlaylistIds || [],
      unsharePlaylistIds: unsharePlaylistIds || [],
      copyPlaylistIds: copyPlaylistIds || [],
      uncopyPlaylistIds: uncopyPlaylistIds || [],
    });
    res.json({ message: 'Batch share updated' });
  } catch (err) {
    next(err);
  }
});

// ========================= Playlist Detail =========================

// GET /api/playlists/:id — playlist with clips
router.get('/:id', playlistAccess, requireView, async (req, res, next) => {
  try {
    const playlist = await playlistService.getPlaylistById(
      req.params.id,
      req.user.id,
      req.query.q || ''
    );

    // Compute ETag from the serialized body. For a ~50-clip playlist this
    // is cheap (~1ms) and lets browsers return 304 on repeat fetches.
    const body = JSON.stringify(playlist);
    const etag = `"${crypto.createHash('sha1').update(body).digest('base64').slice(0, 22)}"`;
    res.setHeader('ETag', etag);
    // Allow short-lived browser cache with background revalidation.
    // Private because playlists may contain user-specific flags (isOwner, etc.)
    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(body);
  } catch (err) {
    next(err);
  }
});

// PUT /api/playlists/:id — update playlist
router.put('/:id', playlistAccess, requireOwner, validate(updatePlaylistSchema), async (req, res, next) => {
  try {
    const playlist = await playlistService.updatePlaylist(req.params.id, req.validated);
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/playlists/:id — delete playlist
router.delete('/:id', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    await playlistService.deletePlaylist(req.params.id);
    res.json({ message: 'Playlist deleted' });
  } catch (err) {
    next(err);
  }
});

// ========================= Clip Management =========================

// POST /api/playlists/:id/clips — add clip to playlist
router.post('/:id/clips', playlistAccess, requireOwner, validate(addClipSchema), async (req, res, next) => {
  try {
    const pc = await playlistService.addClipToPlaylist(req.params.id, req.validated.clipId);
    res.status(201).json(pc);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/playlists/:id/clips — remove clip from playlist
router.delete('/:id/clips', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { clipId } = req.body;
    await playlistService.removeClipFromPlaylist(req.params.id, clipId, req.user.id);
    res.json({ message: 'Clip removed from playlist' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/playlists/:id/clips/reorder — update clip positions
router.put('/:id/clips/reorder', playlistAccess, requireOwner, validate(reorderClipsSchema), async (req, res, next) => {
  try {
    await playlistService.reorderClips(req.params.id, req.validated.clipIds);
    res.json({ message: 'Clips reordered' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/playlists/:id/clips/batch — batch update clip customizations (must be before /:clipId)
router.put('/:id/clips/batch', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: { message: 'updates array is required' } });
    }
    await playlistService.batchUpdateClips(req.params.id, updates);
    res.json({ message: 'Clips updated', count: updates.length });
  } catch (err) {
    next(err);
  }
});

// PUT /api/playlists/:id/clips/:clipId — update clip customization
router.put('/:id/clips/:clipId', playlistAccess, requireOwner, validate(updateClipCustomizationSchema), async (req, res, next) => {
  try {
    const pc = await playlistService.updateClipCustomization(
      req.params.id,
      req.params.clipId,
      req.validated
    );
    res.json(pc);
  } catch (err) {
    next(err);
  }
});

// PUT /api/playlists/:id/clips/:clipId/swap — swap clip for another clip of the same song
router.put('/:id/clips/:clipId/swap', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { newClipId } = req.body;
    if (!newClipId) {
      return res.status(400).json({ error: { message: 'newClipId is required' } });
    }
    const result = await playlistService.swapClip(req.params.id, req.params.clipId, newClipId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ========================= Import Clips =========================


// POST /api/playlists/:id/import/by-qq — import clips from QQ Music playlist
router.post('/:id/import/by-qq', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { importByQQ } = require('../../scripts/import-playlist-by-qq');
    const { qqPlaylistId } = req.body;
    if (!qqPlaylistId) {
      return res.status(400).json({ error: { message: 'qqPlaylistId is required' } });
    }
    const result = await importByQQ(qqPlaylistId, req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/import/by-netease — import clips from NetEase Cloud Music playlist
router.post('/:id/import/by-netease', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { importByNetease } = require('../../scripts/import-playlist-by-netease');
    const { neteasePlaylistId } = req.body;
    if (!neteasePlaylistId) {
      return res.status(400).json({ error: { message: 'neteasePlaylistId is required' } });
    }
    const result = await importByNetease(neteasePlaylistId, req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/import/by-file — import clips from xlsx file
router.post('/:id/import/by-file', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');

    upload(req, res, async (err) => {
      if (err) return next(err);
      if (!req.file) {
        return res.status(400).json({ error: { message: 'No file uploaded' } });
      }
      try {
        const { importByFile } = require('../../scripts/import-playlist-by-file');
        const result = await importByFile(req.file.buffer, req.params.id);
        res.json(result);
      } catch (e) {
        next(e);
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/import/by-internal — import clips from another internal playlist
router.post('/:id/import/by-internal', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { targetPlaylistId } = req.body;
    if (!targetPlaylistId) {
      return res.status(400).json({ error: { message: 'targetPlaylistId is required' } });
    }

    const prisma = require('../db/client');

    // Verify source playlist exists and user has access
    const source = await prisma.playlist.findUnique({
      where: { id: targetPlaylistId },
      include: {
        shares: { where: { userId: req.user.id }, select: { id: true }, take: 1 },
        copyPermissions: { where: { userId: req.user.id }, select: { id: true }, take: 1 },
      },
    });
    if (!source) {
      return res.status(404).json({ error: { message: 'Source playlist not found' } });
    }
    const canView = source.userId === req.user.id || source.isPublic
      || source.shares.length > 0 || source.copyPermissions.length > 0;
    if (!canView) {
      return res.status(404).json({ error: { message: 'Source playlist not found' } });
    }

    // Get clips from source playlist
    const sourceClips = await prisma.playlistClip.findMany({
      where: { playlistId: targetPlaylistId },
      orderBy: { position: 'asc' },
      select: { clipId: true },
    });

    // Get existing clips in target playlist
    const existingClips = await prisma.playlistClip.findMany({
      where: { playlistId: req.params.id },
      select: { clipId: true },
    });
    const existingSet = new Set(existingClips.map((c) => c.clipId));

    // Get max position
    const maxPos = await prisma.playlistClip.aggregate({
      where: { playlistId: req.params.id },
      _max: { position: true },
    });
    let position = (maxPos._max.position ?? -1) + 1;

    let added = 0;
    let skipped = 0;

    for (const sc of sourceClips) {
      if (existingSet.has(sc.clipId)) {
        skipped++;
        continue;
      }
      await prisma.playlistClip.create({
        data: { playlistId: req.params.id, clipId: sc.clipId, position },
      });
      existingSet.add(sc.clipId);
      position++;
      added++;
    }

    res.json({ added, skipped, notFound: [], artistMismatch: [] });
  } catch (err) {
    next(err);
  }
});

// ========================= Shares =========================

// GET /api/playlists/:id/shares
router.get('/:id/shares', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const shares = await shareService.getShares(req.params.id);
    res.json({ shares });
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/shares
router.post('/:id/shares', playlistAccess, requireOwner, validate(shareSchema), async (req, res, next) => {
  try {
    await shareService.addShare(req.params.id, req.validated.userId);
    res.status(201).json({ message: 'Playlist shared' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/playlists/:id/shares/:userId
router.delete('/:id/shares/:userId', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    await shareService.removeShare(req.params.id, req.params.userId);
    res.json({ message: 'Share removed' });
  } catch (err) {
    next(err);
  }
});

// ========================= Copy Permissions =========================

// GET /api/playlists/:id/copy-permissions
router.get('/:id/copy-permissions', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const users = await shareService.getCopyPermissions(req.params.id);
    res.json({ copyPermissions: users });
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/copy-permissions
router.post('/:id/copy-permissions', playlistAccess, requireOwner, validate(shareSchema), async (req, res, next) => {
  try {
    await shareService.addCopyPermission(req.params.id, req.validated.userId);
    res.status(201).json({ message: 'Copy permission granted' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/playlists/:id/copy-permissions/:userId
router.delete('/:id/copy-permissions/:userId', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    await shareService.removeCopyPermission(req.params.id, req.params.userId);
    res.json({ message: 'Copy permission revoked' });
  } catch (err) {
    next(err);
  }
});

// ========================= Compare =========================

// POST /api/playlists/:id/compare/qq — compare with a QQ Music playlist
router.post('/:id/compare/qq', playlistAccess, requireView, async (req, res, next) => {
  try {
    const { fetchQQPlaylist } = require('../../scripts/import-playlist-by-qq');
    const { qqPlaylistId } = req.body;
    if (!qqPlaylistId) {
      return res.status(400).json({ error: { message: 'qqPlaylistId is required' } });
    }
    const externalSongs = await fetchQQPlaylist(qqPlaylistId);
    const report = await compareWithPlaylist(req.params.id, externalSongs);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/compare/netease — compare with a NetEase playlist
router.post('/:id/compare/netease', playlistAccess, requireView, async (req, res, next) => {
  try {
    const { fetchNeteasePlaylist } = require('../../scripts/import-playlist-by-netease');
    const { neteasePlaylistId } = req.body;
    if (!neteasePlaylistId) {
      return res.status(400).json({ error: { message: 'neteasePlaylistId is required' } });
    }
    const externalSongs = await fetchNeteasePlaylist(neteasePlaylistId);
    const report = await compareWithPlaylist(req.params.id, externalSongs);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/compare/internal — compare with another internal playlist
router.post('/:id/compare/internal', playlistAccess, requireView, async (req, res, next) => {
  try {
    const prisma = require('../db/client');
    const { targetPlaylistId } = req.body;
    if (!targetPlaylistId) {
      return res.status(400).json({ error: { message: 'targetPlaylistId is required' } });
    }
    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetPlaylistId)) {
      return res.status(400).json({ error: { message: 'Invalid playlist ID format' } });
    }
    // Check target playlist exists and user has access
    const target = await prisma.playlist.findUnique({
      where: { id: targetPlaylistId },
      include: {
        shares: { where: { userId: req.user.id }, select: { id: true }, take: 1 },
        copyPermissions: { where: { userId: req.user.id }, select: { id: true }, take: 1 },
      },
    });
    if (!target) {
      return res.status(404).json({ error: { message: 'Playlist not found' } });
    }
    const canView = target.userId === req.user.id || target.isPublic
      || target.shares.length > 0 || target.copyPermissions.length > 0;
    if (!canView) {
      return res.status(404).json({ error: { message: 'Playlist not found' } });
    }
    // Fetch songs from the target playlist
    const targetClips = await prisma.playlistClip.findMany({
      where: { playlistId: targetPlaylistId },
      include: { clip: { select: { song: { select: { id: true, title: true, artist: true } } } } },
    });
    // Deduplicate by songId and format as externalSongs
    const seen = new Set();
    const externalSongs = [];
    for (const pc of targetClips) {
      const song = pc.clip.song;
      if (!seen.has(song.id)) {
        seen.add(song.id);
        externalSongs.push({ title: song.title, artist: song.artist });
      }
    }
    const report = await compareWithPlaylist(req.params.id, externalSongs);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

/**
 * Compare external songs with a local playlist's songs.
 * Returns: { missing, titleMatch, artistMismatch, externalTotal, localTotal }
 */
async function compareWithPlaylist(playlistId, externalSongs) {
  const prisma = require('../db/client');

  // Get all songs in the local playlist (select only needed fields)
  const playlistClips = await prisma.playlistClip.findMany({
    where: { playlistId },
    include: {
      clip: {
        select: {
          song: { select: { id: true, title: true, artist: true } },
        },
      },
    },
  });

  // Deduplicate local songs by songId
  const localSongsMap = new Map();
  for (const pc of playlistClips) {
    const song = pc.clip.song;
    if (!localSongsMap.has(song.id)) {
      localSongsMap.set(song.id, { title: song.title, artist: song.artist });
    }
  }

  // Build title lookup map: lowercase title -> array of local songs (O(1) lookup)
  const localByTitle = new Map();
  for (const song of localSongsMap.values()) {
    const key = song.title.trim().toLowerCase();
    if (!localByTitle.has(key)) localByTitle.set(key, []);
    localByTitle.get(key).push(song);
  }

  const missing = [];
  const titleMatch = [];
  const artistMismatch = [];

  for (const ext of externalSongs) {
    const extTitle = ext.title.trim().toLowerCase();
    const matches = localByTitle.get(extTitle);

    if (!matches) {
      missing.push({ title: ext.title, artist: ext.artist });
      continue;
    }

    const extArtists = ext.artist.split('_').map((a) => a.trim().toLowerCase());
    let hasArtistMatch = false;
    for (const match of matches) {
      const localArtists = match.artist.split('_').map((a) => a.trim().toLowerCase());
      if (extArtists.some((ea) => localArtists.some((la) => la.includes(ea) || ea.includes(la)))) {
        hasArtistMatch = true;
        break;
      }
    }

    if (hasArtistMatch) {
      titleMatch.push({ title: ext.title, artist: ext.artist });
    } else {
      artistMismatch.push({
        title: ext.title,
        externalArtist: ext.artist,
        localArtist: matches[0].artist,
      });
    }
  }

  // Find local songs not in external playlist
  const extTitles = new Set(externalSongs.map((e) => e.title.trim().toLowerCase()));
  const localOnly = [...localSongsMap.values()].filter(
    (s) => !extTitles.has(s.title.trim().toLowerCase())
  );

  return {
    missing,
    titleMatch,
    artistMismatch,
    localOnly,
    externalTotal: externalSongs.length,
    localTotal: localSongsMap.size,
  };
}

// ========================= Copy =========================

// POST /api/playlists/:id/copy
router.post('/:id/copy', playlistAccess, async (req, res, next) => {
  try {
    if (!req.playlistAccess.canCopy) {
      return next(new ForbiddenError());
    }
    const copied = await playlistService.copyPlaylist(req.params.id, req.user.id);
    res.status(201).json(copied);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
