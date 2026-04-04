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

  // ETag based on file size + last modified time
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();

  // Return 304 if client has a matching cached copy
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }

  // Cache headers — clips use version param for cache busting on regenerate
  const cacheControl = isClip
    ? 'public, max-age=2592000'   // 30 days for clips (version param busts cache)
    : 'public, max-age=604800';   // 7 days for full songs

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
      'ETag': etag,
      'Last-Modified': lastModified,
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => { if (!res.headersSent) res.sendStatus(500); });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      'ETag': etag,
      'Last-Modified': lastModified,
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) res.sendStatus(500); });
    stream.pipe(res);
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
