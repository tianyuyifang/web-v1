const prisma = require('../db/client');
const { NotFoundError } = require('../utils/errors');
const { searchSongs } = require('./searchService');

async function getSongs(query, cursor, limit, strict = false, userRole) {
  const songs = await searchSongs(query, cursor, limit, strict);

  const hasMore = songs.length > limit;
  const results = hasMore ? songs.slice(0, limit) : songs;
  const nextCursor = hasMore ? results[results.length - 1].id : null;

  // List responses omit lyrics to save egress — use getSongById for full song detail.
  return {
    songs: results.map((s) => formatSong(s, { includeLyrics: false, userRole })),
    nextCursor,
  };
}

async function getSongById(songId, userRole) {
  const song = await prisma.song.findUnique({
    where: { id: songId },
    include: { clips: { orderBy: { start: 'asc' } } },
  });
  if (!song) throw new NotFoundError('Song');
  return formatSong(song, { includeLyrics: true, userRole });
}

function formatSong(song, { includeLyrics = true, userRole } = {}) {
  const clips = (song.clips || [])
    .filter((c) => userRole === 'ADMIN' || c.isGlobal)
    .map((c) => ({
      id: c.id,
      start: c.start,
      length: c.length,
    }));
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    duration: song.duration,
    filePath: song.filePath,
    ...(includeLyrics ? { lyrics: song.lyrics } : {}),
    starts: song.starts,
    clips,
  };
}

async function getSongClips(songId, userId, userRole) {
  const clips = await prisma.clip.findMany({
    where: {
      songId,
      // Admins see all clips; others see global + clips in their playlists (discovery model)
      ...(userRole === 'ADMIN' ? {} : {
        OR: [
          { isGlobal: true },
          ...(userId ? [{ playlistClips: { some: { playlist: { userId } } } }] : []),
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
