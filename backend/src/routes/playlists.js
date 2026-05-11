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
  mergePlaylistSchema,
} = require('../validators/playlists');
const playlistService = require('../services/playlistService');
const shareService = require('../services/shareService');
const mergeService = require('../services/mergeService');
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

// ========================= Diff =========================

/**
 * Build a one-directional diff: B relative to A.
 * Inputs are arrays of playlistClip rows that include clip.id, clip.songId,
 * clip.start, clip.length, and clip.song.{title,artist}.
 *
 * Two-pass matching:
 *   1. Match by clip.id (same clip row). Differing metadata -> modifiedInB.
 *   2. Among unmatched rows, pair by clip.songId in playlist-position order.
 *      Each pair becomes a modifiedInB entry with `clipBoundaries` in its diffs.
 *      Leftovers go to newInB / removedFromB.
 *
 * Comparison rules for metadata fields:
 *   - speed: numeric exact equality
 *   - colorTag: nullable string; strict === (null != "")
 *   - comment: nullable string; null and "" treated as equal; trimmed
 *   - sectionLabel: nullable string; null and "" treated as equal; trimmed
 *   - clipBoundaries: true if clip.start OR clip.length differs
 *   - position and pitch are NOT compared
 */
function buildDiff(aRows, bRows) {
  const normalize = (v) => {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  };
  const equalText = (x, y) => normalize(x) === normalize(y);

  const formatNewOrRemoved = (pc) => ({
    clipId: pc.clipId,
    song: { title: pc.clip.song.title, artist: pc.clip.song.artist },
    speed: pc.speed,
    colorTag: pc.colorTag,
    comment: pc.comment,
    sectionLabel: pc.sectionLabel,
  });

  const computeDiffs = (aPc, bPc) => {
    const diffs = [];
    if (aPc.speed !== bPc.speed) diffs.push('speed');
    if (aPc.colorTag !== bPc.colorTag) diffs.push('colorTag');
    if (!equalText(aPc.comment, bPc.comment)) diffs.push('comment');
    if (!equalText(aPc.sectionLabel, bPc.sectionLabel)) diffs.push('sectionLabel');
    if (
      aPc.clip.start !== bPc.clip.start ||
      aPc.clip.length !== bPc.clip.length
    ) {
      diffs.push('clipBoundaries');
    }
    return diffs;
  };

  const buildModifiedEntry = (aPc, bPc, diffs, sameClipId) => {
    const entry = {
      clipId: bPc.clipId,
      song: { title: bPc.clip.song.title, artist: bPc.clip.song.artist },
      a: {
        speed: aPc.speed,
        colorTag: aPc.colorTag,
        comment: aPc.comment,
        sectionLabel: aPc.sectionLabel,
        start: aPc.clip.start,
        length: aPc.clip.length,
      },
      b: {
        speed: bPc.speed,
        colorTag: bPc.colorTag,
        comment: bPc.comment,
        sectionLabel: bPc.sectionLabel,
        start: bPc.clip.start,
        length: bPc.clip.length,
      },
      diffs,
    };
    if (!sameClipId) entry.aClipId = aPc.clipId;
    return entry;
  };

  // ---- Pass 1: match by clip.id ----
  const aById = new Map();
  for (const pc of aRows) aById.set(pc.clipId, pc);
  const bById = new Map();
  for (const pc of bRows) bById.set(pc.clipId, pc);

  const modifiedInB = [];
  const aUnmatched = [];
  const bUnmatched = [];

  for (const aPc of aRows) {
    if (!bById.has(aPc.clipId)) {
      aUnmatched.push(aPc);
    }
  }
  for (const bPc of bRows) {
    if (!aById.has(bPc.clipId)) {
      bUnmatched.push(bPc);
      continue;
    }
    const aPc = aById.get(bPc.clipId);
    const diffs = computeDiffs(aPc, bPc);
    if (diffs.length > 0) {
      modifiedInB.push(buildModifiedEntry(aPc, bPc, diffs, true));
    }
  }

  // ---- Pass 2: pair leftovers by clip.songId in order ----
  const aBySongId = new Map();
  for (const pc of aUnmatched) {
    if (!aBySongId.has(pc.clip.songId)) aBySongId.set(pc.clip.songId, []);
    aBySongId.get(pc.clip.songId).push(pc);
  }
  const bBySongId = new Map();
  for (const pc of bUnmatched) {
    if (!bBySongId.has(pc.clip.songId)) bBySongId.set(pc.clip.songId, []);
    bBySongId.get(pc.clip.songId).push(pc);
  }

  const newInB = [];
  const removedFromB = [];

  // For each songId in B's leftovers, try to pair with A's leftovers of the same song.
  for (const [songId, bList] of bBySongId) {
    const aList = aBySongId.get(songId) || [];
    const pairCount = Math.min(aList.length, bList.length);
    for (let i = 0; i < pairCount; i++) {
      const aPc = aList[i];
      const bPc = bList[i];
      const diffs = computeDiffs(aPc, bPc);
      if (diffs.length > 0) {
        modifiedInB.push(buildModifiedEntry(aPc, bPc, diffs, false));
      }
      // If diffs is empty (same song, same boundaries, same metadata, different clipId),
      // intentionally skip — no change to report.
    }
    // Anything in B beyond the paired prefix is genuinely new.
    for (let i = pairCount; i < bList.length; i++) {
      newInB.push(formatNewOrRemoved(bList[i]));
    }
  }

  // Anything in A whose songId never appeared in B's leftovers, OR whose count
  // exceeded B's count for that songId, goes to removedFromB.
  for (const [songId, aList] of aBySongId) {
    const bList = bBySongId.get(songId) || [];
    const pairCount = Math.min(aList.length, bList.length);
    for (let i = pairCount; i < aList.length; i++) {
      removedFromB.push({
        clipId: aList[i].clipId,
        song: {
          title: aList[i].clip.song.title,
          artist: aList[i].clip.song.artist,
        },
      });
    }
  }

  return { newInB, modifiedInB, removedFromB };
}

// GET /api/playlists/diff?a=<uuid>&b=<uuid> — one-directional diff: B vs baseline A
router.get('/diff', async (req, res, next) => {
  try {
    const prisma = require('../db/client');
    const { a, b } = req.query;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!a || !b) {
      return res.status(400).json({ error: { message: 'Both a and b query parameters are required' } });
    }
    if (!UUID_RE.test(a) || !UUID_RE.test(b)) {
      return res.status(400).json({ error: { message: 'Invalid playlist ID format' } });
    }
    if (a === b) {
      return res.status(400).json({ error: { message: 'Cannot diff a playlist against itself' } });
    }

    const userId = req.user.id;
    const [aPl, bPl] = await Promise.all([
      prisma.playlist.findUnique({
        where: { id: a },
        include: {
          shares: { where: { userId }, select: { id: true }, take: 1 },
          copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
        },
      }),
      prisma.playlist.findUnique({
        where: { id: b },
        include: {
          shares: { where: { userId }, select: { id: true }, take: 1 },
          copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
        },
      }),
    ]);

    const canView = (pl) =>
      !!pl &&
      (pl.userId === userId ||
        pl.isPublic ||
        pl.shares.length > 0 ||
        pl.copyPermissions.length > 0);

    if (!canView(aPl) || !canView(bPl)) {
      return res.status(404).json({ error: { message: 'Playlist not found' } });
    }

    const [aClips, bClips] = await Promise.all([
      prisma.playlistClip.findMany({
        where: { playlistId: a },
        orderBy: { position: 'asc' },
        include: {
          clip: {
            select: {
              id: true,
              songId: true,
              start: true,
              length: true,
              song: { select: { title: true, artist: true } },
            },
          },
        },
      }),
      prisma.playlistClip.findMany({
        where: { playlistId: b },
        orderBy: { position: 'asc' },
        include: {
          clip: {
            select: {
              id: true,
              songId: true,
              start: true,
              length: true,
              song: { select: { title: true, artist: true } },
            },
          },
        },
      }),
    ]);

    const diff = buildDiff(aClips, bClips);
    res.json({
      a: { id: aPl.id, name: aPl.name },
      b: { id: bPl.id, name: bPl.name },
      ...diff,
    });
  } catch (err) {
    next(err);
  }
});

// ========================= Merge =========================

// POST /api/playlists/merge — create a new playlist by merging B into A
router.post('/merge', validate(mergePlaylistSchema), async (req, res, next) => {
  try {
    const { aId, bId } = req.validated;
    const result = await mergeService.mergePlaylists(req.user.id, aId, bId);
    res.status(201).json(result);
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

// DELETE /api/playlists/:id/clips/batch — batch remove clips from playlist
router.delete('/:id/clips/batch', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { clipIds } = req.body;
    if (!Array.isArray(clipIds) || clipIds.length === 0) {
      return res.status(400).json({ error: { message: 'clipIds array is required' } });
    }
    await playlistService.batchRemoveClips(req.params.id, clipIds, req.user.id);
    res.json({ message: 'Clips removed', count: clipIds.length });
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

// POST /api/playlists/:id/import/by-kugou — import clips from KuGou playlist
router.post('/:id/import/by-kugou', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { importByKugou } = require('../../scripts/import-playlist-by-kugou');
    const { kugouPlaylistId } = req.body;
    if (!kugouPlaylistId) {
      return res.status(400).json({ error: { message: 'kugouPlaylistId is required' } });
    }
    const result = await importByKugou(kugouPlaylistId, req.params.id);
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

    // Get clips from source playlist with song info
    const sourceClips = await prisma.playlistClip.findMany({
      where: { playlistId: targetPlaylistId },
      orderBy: { position: 'asc' },
      include: { clip: { include: { song: { select: { title: true, artist: true } } } } },
    });

    // Build title map of existing songs in target playlist
    const existingSongs = await prisma.playlistClip.findMany({
      where: { playlistId: req.params.id },
      include: { clip: { include: { song: { select: { title: true, artist: true } } } } },
    });
    const existingTitleMap = new Map();
    for (const pc of existingSongs) {
      existingTitleMap.set(pc.clip.song.title, pc.clip.song.artist);
    }

    // Get max position
    const maxPos = await prisma.playlistClip.aggregate({
      where: { playlistId: req.params.id },
      _max: { position: true },
    });
    let position = (maxPos._max.position ?? -1) + 1;

    let added = 0;
    let skipped = 0;
    const titleConflict = [];

    for (const sc of sourceClips) {
      const songTitle = sc.clip.song.title;
      const songArtist = sc.clip.song.artist;
      const existingArtist = existingTitleMap.get(songTitle);

      if (existingArtist !== undefined) {
        const dbArtists = existingArtist.split('_').map((a) => a.trim().toLowerCase());
        const srcArtists = songArtist.split('_').map((a) => a.trim().toLowerCase());
        const sameArtist = srcArtists.some((sa) => dbArtists.some((da) => da.includes(sa) || sa.includes(da)));
        if (sameArtist) {
          skipped++;
        } else {
          titleConflict.push({ title: songTitle, externalArtist: songArtist, localArtist: existingArtist });
        }
        continue;
      }

      await prisma.playlistClip.create({
        data: { playlistId: req.params.id, clipId: sc.clipId, position },
      });
      existingTitleMap.set(songTitle, songArtist);
      position++;
      added++;
    }

    res.json({ added, skipped, notFound: [], titleConflict });
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

// POST /api/playlists/:id/compare/kugou — compare with a KuGou playlist
router.post('/:id/compare/kugou', playlistAccess, requireView, async (req, res, next) => {
  try {
    const { fetchKugouPlaylist } = require('../../scripts/import-playlist-by-kugou');
    const { kugouPlaylistId } = req.body;
    if (!kugouPlaylistId) {
      return res.status(400).json({ error: { message: 'kugouPlaylistId is required' } });
    }
    const externalSongs = await fetchKugouPlaylist(kugouPlaylistId);
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

  // Build title lookup map: trimmed title -> array of local songs (O(1) lookup)
  // Case-sensitive: "Love" and "love" are treated as distinct titles.
  const localByTitle = new Map();
  for (const song of localSongsMap.values()) {
    const key = song.title.trim();
    if (!localByTitle.has(key)) localByTitle.set(key, []);
    localByTitle.get(key).push(song);
  }

  const missing = [];
  const titleMatch = [];
  const artistMismatch = [];

  for (const ext of externalSongs) {
    const extTitle = ext.title.trim();
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

  // Find local songs not in external playlist (case-sensitive)
  const extTitles = new Set(externalSongs.map((e) => e.title.trim()));
  const localOnly = [...localSongsMap.values()].filter(
    (s) => !extTitles.has(s.title.trim())
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
