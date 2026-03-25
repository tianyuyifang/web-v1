const fs = require('fs');
const path = require('path');
const config = require('../config');
const prisma = require('../db/client');
const { NotFoundError } = require('../utils/errors');

/**
 * Resolve the absolute file path for a song's MP3.
 */
async function getSongFilePath(songId) {
  const song = await prisma.song.findUnique({
    where: { id: songId },
    select: { filePath: true },
  });
  if (!song) throw new NotFoundError('Song');

  const fullPath = path.join(config.mp3BasePath, song.filePath);
  if (!fs.existsSync(fullPath)) {
    throw new NotFoundError('Audio file');
  }

  return fullPath;
}

/**
 * Resolve the absolute file path for a clip's MP3.
 */
async function getClipFilePath(clipId) {
  const clip = await prisma.clip.findUnique({
    where: { id: clipId },
    select: { filePath: true },
  });
  if (!clip) throw new NotFoundError('Clip');
  if (!clip.filePath) throw new NotFoundError('Clip audio file');

  const fullPath = path.join(config.clipsBasePath, clip.filePath);
  if (!fs.existsSync(fullPath)) {
    throw new NotFoundError('Clip audio file');
  }

  return fullPath;
}

/**
 * Parse an HTTP Range header.
 * Returns { start, end } or null if no range requested.
 */
function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) return null;

  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start >= fileSize || end >= fileSize || start > end) return null;

  return { start, end };
}

module.exports = { getSongFilePath, getClipFilePath, parseRangeHeader };
