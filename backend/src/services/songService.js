const prisma = require('../db/client');
const { NotFoundError } = require('../utils/errors');
const songSearch = require('./songSearchService');

/**
 * Ranked search (添加歌曲, the 歌曲 tab), `limit` songs from `offset`. With
 * `mine`, each song also lists which of the caller's own playlists hold a
 * clip of it.
 */
async function searchRanked(query, limit, userRole, userId, mine = false, offset = 0) {
  const { ids, total } = await songSearch.search(query, limit, offset);
  if (!ids.length) return { songs: [], total, nextOffset: offset };

  const rows = await prisma.song.findMany({
    where: { id: { in: ids } },
    include: { clips: { orderBy: { start: 'asc' } } },
  });

  // Looked up by clip id: ~10 ms on production for the user with the most
  // playlists, against ~50 ms joining from the song side.
  const playlistsBySong = new Map();
  if (mine && userId) {
    const songOfClip = new Map(rows.flatMap((s) => s.clips.map((c) => [c.id, s.id])));
    const inMine = songOfClip.size ? await prisma.$queryRawUnsafe(
      `SELECT DISTINCT pc.clip_id, p.id, p.name
         FROM playlist_clips pc
         JOIN playlists p ON p.id = pc.playlist_id
        WHERE p.user_id = $1::uuid AND pc.clip_id = ANY($2::uuid[])`,
      userId, [...songOfClip.keys()]
    ) : [];
    for (const r of inMine) {
      const songId = songOfClip.get(r.clip_id);
      if (!playlistsBySong.has(songId)) playlistsBySong.set(songId, new Map());
      playlistsBySong.get(songId).set(r.id, { id: r.id, name: r.name });
    }
  }
  for (const [songId, byPlaylist] of playlistsBySong) {
    playlistsBySong.set(songId, [...byPlaylist.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')));
  }

  const byId = new Map(rows.map((s) => [s.id, s]));
  const songs = ids.filter((id) => byId.has(id)).map((id) => {
    const song = formatSong(byId.get(id), { includeLyrics: false, userRole });
    if (mine) song.myPlaylists = playlistsBySong.get(id) || [];
    return song;
  });
  // Songs deleted since the index was built are dropped (and not counted);
  // the next page starts after every id this one covered.
  return { songs, total: total - (ids.length - songs.length), nextOffset: offset + ids.length };
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
