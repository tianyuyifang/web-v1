const prisma = require('../db/client');
const { NotFoundError } = require('../utils/errors');
const songSearch = require('./songSearchService');

/**
 * Ranked search (添加歌曲, the 歌曲 tab). With `mine`, each song also lists
 * which of the caller's own playlists hold a clip of it.
 */
async function searchRanked(query, limit, userRole, userId, mine = false) {
  const { ids, total } = await songSearch.search(query, limit);
  if (!ids.length) return { songs: [], total };

  const [rows, inMine] = await Promise.all([
    prisma.song.findMany({
      where: { id: { in: ids } },
      include: { clips: { orderBy: { start: 'asc' } } },
    }),
    mine && userId
      ? prisma.$queryRawUnsafe(
        `SELECT DISTINCT c.song_id, p.id, p.name
           FROM playlists p
           JOIN playlist_clips pc ON pc.playlist_id = p.id
           JOIN clips c ON c.id = pc.clip_id
          WHERE p.user_id = $1::uuid AND c.song_id = ANY($2::uuid[])`,
        userId, ids
      )
      : [],
  ]);

  const playlistsBySong = new Map();
  for (const r of inMine) {
    if (!playlistsBySong.has(r.song_id)) playlistsBySong.set(r.song_id, []);
    playlistsBySong.get(r.song_id).push({ id: r.id, name: r.name });
  }
  for (const list of playlistsBySong.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const byId = new Map(rows.map((s) => [s.id, s]));
  const songs = ids.filter((id) => byId.has(id)).map((id) => {
    const song = formatSong(byId.get(id), { includeLyrics: false, userRole });
    if (mine) song.myPlaylists = playlistsBySong.get(id) || [];
    return song;
  });
  return { songs, total };
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

module.exports = { searchRanked, getSongById, getSongClips };
