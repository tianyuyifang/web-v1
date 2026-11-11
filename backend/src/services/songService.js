const prisma = require('../db/client');
const { NotFoundError } = require('../utils/errors');
const songSearch = require('./songSearchService');

// Up to this many matches, look those songs up; past it, read the user's
// whole set. Measured on production (2026-11-11): looking up 50 songs takes
// ~6 ms (~65 ms if they are the most-used ones), 200 popular ones ~185 ms;
// the whole set takes ~150-250 ms for the three largest users (~21k songs,
// 30-43k playlist entries) and ~10 ms or less for everyone else.
const LOOKUP_MATCHES_MAX = 100;

// Whole-set reads that took longer than this put their user in the slow lane:
// from then on that user's whole-set reads run one at a time (with every other
// slow user's), so several large users searching at once queue among
// themselves instead of filling the 2-core database together and slowing
// everyone else. A read under it takes the user back out. Kept in memory
// only; after a restart each user's first read decides.
const SLOW_READ_MS = 50;
const slowReaders = new Set();
let slowLane = Promise.resolve();

function inSlowLane(fn) {
  const run = slowLane.then(fn, fn);
  slowLane = run.catch(() => {}); // one failed read must not block the ones queued after it
  return run;
}

async function readWholeSet(userId) {
  const started = Date.now();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT c.song_id
       FROM playlist_clips pc
       JOIN playlists p ON p.id = pc.playlist_id
       JOIN clips c ON c.id = pc.clip_id
      WHERE p.user_id = $1::uuid`,
    userId
  );
  if (Date.now() - started > SLOW_READ_MS) slowReaders.add(userId);
  else slowReaders.delete(userId);
  return rows;
}

/** Which of `songIds` (one search's matches) the user's own playlists hold. */
async function heldByOwnPlaylists(userId, songIds) {
  if (!songIds.length) return new Set();
  let rows;
  if (songIds.length <= LOOKUP_MATCHES_MAX) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT c.song_id
         FROM clips c
         JOIN playlist_clips pc ON pc.clip_id = c.id
         JOIN playlists p ON p.id = pc.playlist_id
        WHERE p.user_id = $1::uuid AND c.song_id = ANY($2::uuid[])`,
      userId, songIds
    );
  } else if (slowReaders.has(userId)) {
    rows = await inSlowLane(() => readWholeSet(userId));
  } else {
    rows = await readWholeSet(userId);
  }
  return new Set(rows.map((r) => r.song_id));
}

/**
 * Ranked search (添加歌曲, the 歌曲 tab), `limit` songs from `offset`. With
 * `mine` (the 歌曲 tab), only songs that one of the caller's own playlists
 * holds a clip of, each listing those playlists; `libraryTotal` says how many
 * the whole library matched, so "not in your playlists" can be told from
 * "no such song".
 */
async function searchRanked(query, limit, userRole, userId, mine = false, offset = 0) {
  const keep = mine && userId ? (songIds) => heldByOwnPlaylists(userId, songIds) : null;
  const { ids, total, libraryTotal } = await songSearch.search(query, limit, offset, keep);
  const counts = keep ? { libraryTotal } : {};
  if (!ids.length) return { songs: [], total, nextOffset: offset, ...counts };

  const rows = await prisma.song.findMany({
    where: { id: { in: ids } },
    // Only what formatSong sends: not 50 songs' lyrics and their clips' lyrics
    select: {
      id: true, title: true, artist: true, duration: true, filePath: true, starts: true,
      clips: { orderBy: { start: 'asc' }, select: { id: true, start: true, length: true, isGlobal: true } },
    },
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
  return { songs, total: total - (ids.length - songs.length), nextOffset: offset + ids.length, ...counts };
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
