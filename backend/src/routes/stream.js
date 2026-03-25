const router = require('express').Router();
const fs = require('fs');
const fsp = require('fs/promises');
const { getSongFilePath, getClipFilePath, parseRangeHeader } = require('../services/streamService');

/**
 * Stream a file with byte-range support and caching.
 * isClip=true for clip files (immutable, cache aggressively).
 */
async function streamFile(filePath, req, res, { isClip = false } = {}) {
  const stat = await fsp.stat(filePath);
  const fileSize = stat.size;

  // Cache headers — clips are immutable, songs may change rarely
  const cacheControl = isClip
    ? 'public, max-age=31536000, immutable'  // 1 year, never revalidate
    : 'public, max-age=86400';               // 1 day for full songs

  const range = parseRangeHeader(req.headers.range, fileSize);

  if (range) {
    const { start, end } = range;
    const contentLength = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': cacheControl,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    });

    fs.createReadStream(filePath).pipe(res);
  }
}

// GET /api/stream/song/:songId — stream full song MP3
router.get('/song/:songId', async (req, res, next) => {
  try {
    const filePath = await getSongFilePath(req.params.songId);
    await streamFile(filePath, req, res);
  } catch (err) {
    next(err);
  }
});

// GET /api/stream/clip/:clipId — stream clip MP3
router.get('/clip/:clipId', async (req, res, next) => {
  try {
    const filePath = await getClipFilePath(req.params.clipId);
    await streamFile(filePath, req, res, { isClip: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/stream/:songId — legacy song stream (backwards compat)
router.get('/:songId', async (req, res, next) => {
  try {
    const filePath = await getSongFilePath(req.params.songId);
    await streamFile(filePath, req, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
