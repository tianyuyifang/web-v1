const path = require('path');
const prisma = require('../db/client');
const config = require('../config');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { sliceLRC } = require('../utils/lrc');
const { clipAudio } = require('../../scripts/clip-audio');

/**
 * Build the clip filename: "title - artistA & artistB - start.mp3"
 */
function buildClipFilename(song, start) {
  const artists = song.artist.split('_').map((a) => a.trim()).join(' & ');
  // Sanitize characters that are invalid in filenames
  const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '_');
  return `${safe(song.title)} - ${safe(artists)} - ${start}.mp3`;
}

async function createClip({ songId, start, length, userId, userRole }) {
  const song = await prisma.song.findUnique({ where: { id: songId } });
  if (!song) throw new NotFoundError('Song');

  if (song.duration && start >= song.duration) {
    throw new ValidationError({ start: ['Start time exceeds song duration'] });
  }

  // Check if a global clip already exists at this start time — reuse it
  let clip = await prisma.clip.findFirst({
    where: { songId, start, isGlobal: true },
  });
  if (clip) return clip;

  // Check if this user already has a clip at this start time
  if (userId) {
    clip = await prisma.clip.findFirst({
      where: { songId, start, userId },
    });
    if (clip) return clip;
  }

  // Slice and adjust lyrics for this clip
  const clipLyrics = sliceLRC(song.lyrics, start, start + length);

  // Build file path and clip the audio
  const clipFilename = buildClipFilename(song, start);
  const sourcePath = path.join(config.mp3BasePath, song.filePath);
  const outputPath = path.join(config.clipsBasePath, clipFilename);

  clipAudio({
    sourcePath,
    outputPath,
    start,
    length,
    lyrics: clipLyrics,
  });

  // Create clip record in DB — user clips default to non-global
  clip = await prisma.clip.create({
    data: {
      songId, start, length,
      filePath: clipFilename,
      lyrics: clipLyrics,
      userId: userId || null,
      isGlobal: !userId || userRole === 'ADMIN',
    },
  });

  // Update song.starts column
  const existing = song.starts ? song.starts.split('|').map(Number) : [];
  const merged = [...new Set([...existing, start])]
    .sort((a, b) => a - b)
    .join('|');
  await prisma.song.update({
    where: { id: songId },
    data: { starts: merged },
  });

  return clip;
}

async function autoClipSong({ songId, length }) {
  const song = await prisma.song.findUnique({ where: { id: songId } });
  if (!song) throw new NotFoundError('Song');
  if (!song.duration) {
    throw new ValidationError({ songId: ['Song has no duration — cannot auto-clip'] });
  }

  const clips = [];
  for (let t = 0; t < song.duration; t += length) {
    const clipLyrics = sliceLRC(song.lyrics, t, t + length);
    const clipFilename = buildClipFilename(song, t);
    const sourcePath = path.join(config.mp3BasePath, song.filePath);
    const outputPath = path.join(config.clipsBasePath, clipFilename);

    clipAudio({
      sourcePath,
      outputPath,
      start: t,
      length,
      lyrics: clipLyrics,
    });

    let clip = await prisma.clip.findFirst({
      where: { songId, start: t, isGlobal: true },
    });
    if (!clip) {
      clip = await prisma.clip.create({
        data: { songId, start: t, length, filePath: clipFilename, lyrics: clipLyrics, isGlobal: true },
      });
    }
    clips.push(clip);
  }

  // Update song.starts
  const existing = song.starts ? song.starts.split('|').map(Number) : [];
  const newStarts = clips.map((c) => c.start);
  const merged = [...new Set([...existing, ...newStarts])]
    .sort((a, b) => a - b)
    .join('|');
  await prisma.song.update({
    where: { id: songId },
    data: { starts: merged },
  });

  return clips;
}

module.exports = { createClip, autoClipSong };
