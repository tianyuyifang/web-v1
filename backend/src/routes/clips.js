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
    const updated = await prisma.clip.update({
      where: { id: req.params.id },
      data: { isGlobal: !clip.isGlobal },
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

    // Find another clip for the same song to reassign playlists
    const replacement = await prisma.clip.findFirst({
      where: { songId: clip.songId, id: { not: clip.id } },
      orderBy: { start: 'asc' },
      select: { id: true },
    });

    // Block deletion if this is the last clip for the song
    if (!replacement) {
      return res.status(400).json({
        error: { message: 'Cannot delete the last clip for a song. Create another clip first.' },
      });
    }

    // Reassign all playlistClip references to the replacement clip
    await prisma.playlistClip.updateMany({
      where: { clipId: clip.id },
      data: { clipId: replacement.id },
    });

    await prisma.clip.delete({ where: { id: req.params.id } });

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

    res.json({ message: 'Clip deleted', replacedBy: replacement?.id || null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
