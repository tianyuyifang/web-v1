const router = require('express').Router();
const validate = require('../middleware/validate');
const { requireRole } = require('../middleware/auth');
const { createClipSchema, autoClipSchema } = require('../validators/clips');
const clipService = require('../services/clipService');
const prisma = require('../db/client');

// POST /api/clips — create a clip from a song
router.post('/', validate(createClipSchema), async (req, res, next) => {
  try {
    const clip = await clipService.createClip({
      ...req.validated,
      userId: req.user.id,
      userRole: req.user.role,
    });
    res.status(201).json(clip);
  } catch (err) {
    next(err);
  }
});

// POST /api/clips/auto — auto-clip entire song at intervals
router.post('/auto', validate(autoClipSchema), async (req, res, next) => {
  try {
    const clips = await clipService.autoClipSong(req.validated);
    res.status(201).json({ clips });
  } catch (err) {
    next(err);
  }
});

// GET /api/clips/:id/lyrics — fetch lyrics for a single clip on demand
router.get('/:id/lyrics', async (req, res, next) => {
  try {
    const clip = await prisma.clip.findUnique({
      where: { id: req.params.id },
      select: { id: true, lyrics: true, version: true },
    });
    if (!clip) return res.status(404).json({ error: { message: 'Clip not found' } });
    // Lyrics are immutable for a given (clipId, version) — aggressive cache
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.json({ id: clip.id, lyrics: clip.lyrics, version: clip.version });
  } catch (err) {
    next(err);
  }
});

// PUT /api/clips/:id/toggle-global — admin toggle clip visibility
router.put('/:id/toggle-global', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const clip = await prisma.clip.findUnique({ where: { id: req.params.id } });
    if (!clip) return res.status(404).json({ error: { message: 'Clip not found' } });
    const newIsGlobal = !clip.isGlobal;
    const updateData = { isGlobal: newIsGlobal };
    // When toggling to non-global, ensure the clip has an owner
    if (!newIsGlobal && !clip.userId) {
      updateData.userId = req.user.id;
    }
    const updated = await prisma.clip.update({
      where: { id: req.params.id },
      data: updateData,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/clips/:id — admin delete a clip
router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const clip = await prisma.clip.findUnique({ where: { id: req.params.id } });
    if (!clip) return res.status(404).json({ error: { message: 'Clip not found' } });

    // Every other clip of the song. The replacement is the one whose start is
    // nearest the deleted clip's: the point of replacing at all is that a
    // playlist keeps a segment as close as possible to the one it loses, and
    // the old earliest-start rule could swap an 80s chorus for a 20s intro.
    // Ties go to the later start — hand-cut clips on this catalogue sit
    // overwhelmingly at the later cut points (the chorus), so later is the
    // likelier match for what users meant.
    const others = await prisma.clip.findMany({
      where: { songId: clip.songId, id: { not: clip.id } },
      select: { id: true, start: true },
    });

    // Block deletion if this is the last clip for the song
    if (others.length === 0) {
      return res.status(400).json({
        error: { message: 'Cannot delete the last clip for a song. Create another clip first.' },
      });
    }

    const replacement = others.reduce((best, c) => {
      const d = Math.abs(c.start - clip.start);
      const bd = Math.abs(best.start - clip.start);
      if (d < bd) return c;
      if (d === bd && c.start > best.start) return c;
      return best;
    });

    // Find playlists that already have the replacement clip — can't reassign those
    const conflicting = await prisma.playlistClip.findMany({
      where: { clipId: replacement.id },
      select: { playlistId: true },
    });
    const conflictingPlaylistIds = conflicting.map((pc) => pc.playlistId);

    // Interactive transaction rather than the array form: the renumbering at
    // the end reads what is left, which an array transaction cannot do.
    await prisma.$transaction(async (tx) => {
      // Delete likes for the clip being deleted (all playlists, all users)
      await tx.like.deleteMany({ where: { clipId: clip.id } });
      // Playlists that already have the replacement: just remove the old entry
      if (conflictingPlaylistIds.length > 0) {
        await tx.playlistClip.deleteMany({
          where: { clipId: clip.id, playlistId: { in: conflictingPlaylistIds } },
        });
      }
      // Remaining playlists: reassign to replacement
      await tx.playlistClip.updateMany({
        where: { clipId: clip.id },
        data: { clipId: replacement.id },
      });
      // Delete the clip record
      await tx.clip.delete({ where: { id: req.params.id } });

      // Close the numbering hole the removed row left. Only the conflicting
      // playlists lost a row — reassigned rows keep their positions — and the
      // ordinary remove-from-playlist path renumbers, so matching it here
      // means a hole can never outlive the request that made it.
      for (const playlistId of conflictingPlaylistIds) {
        const remaining = await tx.playlistClip.findMany({
          where: { playlistId },
          orderBy: { position: 'asc' },
          select: { id: true, position: true },
        });
        const fixes = [];
        remaining.forEach((pc, index) => {
          if (pc.position !== index) {
            fixes.push(tx.playlistClip.update({ where: { id: pc.id }, data: { position: index } }));
          }
        });
        await Promise.all(fixes);
      }
    });

    // Delete audio files from disk (outside transaction — non-critical)
    if (clip.filePath) {
      const path = require('path');
      const fs = require('fs');
      const config = require('../config');
      const mp3Path = path.join(config.clipsBasePath, clip.filePath);
      try { fs.unlinkSync(mp3Path); } catch {}
      try { fs.unlinkSync(mp3Path.replace(/\.mp3$/i, '.lrc')); } catch {}
    }

    // Update song.starts — rebuild from remaining clips
    const remainingClips = await prisma.clip.findMany({
      where: { songId: clip.songId },
      select: { start: true },
    });
    const starts = [...new Set(remainingClips.map((c) => c.start))]
      .sort((a, b) => a - b)
      .join('|') || null;
    await prisma.song.update({
      where: { id: clip.songId },
      data: { starts },
    });

    res.json({ message: 'Clip deleted', replacedBy: replacement.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
