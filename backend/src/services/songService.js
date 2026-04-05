const prisma = require('../db/client');
const { NotFoundError } = require('../utils/errors');
const { searchSongs } = require('./searchService');

async function getSongs(query, cursor, limit, strict = false) {
  const songs = await searchSongs(query, cursor, limit, strict);

  const hasMore = songs.length > limit;
  const results = hasMore ? songs.slice(0, limit) : songs;
  const nextCursor = hasMore ? results[results.length - 1].id : null;

  return {
    songs: results.map(formatSong),
    nextCursor,
  };
}

async function getSongById(songId) {
  const song = await prisma.song.findUnique({
    where: { id: songId },
    include: { clips: { orderBy: { start: 'asc' } } },
  });
  if (!song) throw new NotFoundError('Song');
  return formatSong(song);
}

function formatSong(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    duration: song.duration,
    filePath: song.filePath,
    lyrics: song.lyrics,
    starts: song.starts,
    clips: (song.clips || []).map((c) => ({
      id: c.id,
      start: c.start,
      length: c.length,
    })),
  };
}

async function getSongClips(songId, userId, userRole) {
  const clips = await prisma.clip.findMany({
    where: {
      songId,
      // Admins see all clips; others see global + their own
      ...(userRole === 'ADMIN' ? {} : {
        OR: [
          { isGlobal: true },
          ...(userId ? [{ userId }] : []),
        ],
      }),
    },
    orderBy: { start: 'asc' },
    select: { id: true, start: true, length: true, lyrics: true, isGlobal: true, userId: true },
  });

  return clips.map((c) => ({
    id: c.id,
    start: c.start,
    length: c.length,
    preview: extractFirstLines(c.lyrics, 2),
    isGlobal: c.isGlobal,
    isOwn: c.userId === userId,
  }));
}

function extractFirstLines(lyrics, count = 2) {
  if (!lyrics) return null;
  // LRC format: [mm:ss.xx]text — find first N lines with actual text
  const lines = lyrics.split('\n');
  const result = [];
  for (const line of lines) {
    const match = line.match(/\[\d+:\d+[\d.]*\]\s*(.+)/);
    if (match && match[1].trim()) {
      result.push(match[1].trim());
      if (result.length >= count) break;
    }
  }
  return result.length > 0 ? result.join(' / ') : null;
}

module.exports = { getSongs, getSongById, getSongClips };
