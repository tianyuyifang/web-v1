/**
 * import-playlist-by-netease.js
 *
 * Fetches a NetEase Cloud Music playlist by ID, matches songs against the local DB,
 * creates clips if needed, and adds them to the target playlist.
 *
 * Usage: node scripts/import-playlist-by-netease.js <neteasePlaylistId> <targetPlaylistId>
 *
 * Exports importByNetease() for use by API routes.
 */

require('dotenv').config();
const path = require('path');
const prisma = require('../src/db/client');
const { sliceLRC } = require('../src/utils/lrc');
const { clipAudio } = require('./clip-audio');

const CLIP_LENGTH = 20;

function buildClipFilename(title, artist, start) {
  const artists = artist.split('_').map((a) => a.trim()).join(' & ');
  const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '_');
  return `${safe(title)} - ${safe(artists)} - ${start}.mp3`;
}

/**
 * Fetch playlist tracks from NetEase Cloud Music API.
 *
 * @param {string} neteasePlaylistId
 * @returns {Promise<{ title: string, artist: string }[]>}
 */
async function fetchNeteasePlaylist(neteasePlaylistId) {
  const url = 'https://music.163.com/api/v6/playlist/detail';
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://music.163.com/',
  };

  const resp = await fetch(`${url}?id=${encodeURIComponent(neteasePlaylistId)}`, { headers });
  if (!resp.ok) {
    throw new Error(`NetEase API HTTP ${resp.status}`);
  }

  const data = await resp.json();
  if (data.code !== 200) {
    throw new Error(`NetEase API error: ${data.code} - ${data.msg || 'unknown error'}`);
  }

  let tracks = data.playlist?.tracks || [];
  const trackIds = (data.playlist?.trackIds || []).map((t) => t.id);

  // API only returns a subset of full tracks; fetch all via trackIds
  if (trackIds.length > tracks.length) {
    tracks = await fetchTrackDetails(trackIds, headers);
  }

  return tracks.map((track) => ({
    title: track.name,
    artist: (track.ar || []).map((a) => a.name).join('_'),
  }));
}

/**
 * Fetch full track details when playlist only returns IDs.
 */
async function fetchTrackDetails(trackIds, headers) {
  const url = 'https://music.163.com/api/v3/song/detail';
  const allTracks = [];
  const batchSize = 500;

  for (let i = 0; i < trackIds.length; i += batchSize) {
    const batch = trackIds.slice(i, i + batchSize);
    const c = JSON.stringify(batch.map((id) => ({ id })));

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `c=${encodeURIComponent(c)}`,
    });

    if (!resp.ok) {
      throw new Error(`NetEase song detail API HTTP ${resp.status}`);
    }

    const data = await resp.json();
    allTracks.push(...(data.songs || []));
  }

  return allTracks;
}

/**
 * Find a song in the local DB by title and artist.
 * Returns { song, artistMatch } so callers can track mismatches.
 */
async function findSongInDB(title, artist) {
  const songs = await prisma.song.findMany({
    where: {
      title: { equals: title, mode: 'insensitive' },
    },
  });

  if (songs.length === 0) return { song: null, artistMatch: false };

  if (artist) {
    const neteaseArtists = artist.split('_').map((a) => a.trim().toLowerCase());
    for (const song of songs) {
      const dbArtists = song.artist.split('_').map((a) => a.trim().toLowerCase());
      const hasMatch = neteaseArtists.some((na) =>
        dbArtists.some((da) => da.includes(na) || na.includes(da))
      );
      if (hasMatch) return { song, artistMatch: true };
    }
  }

  return songs.length === 1 ? { song: songs[0], artistMatch: false } : { song: null, artistMatch: false };
}

/**
 * Import songs from a NetEase Cloud Music playlist into a local playlist.
 *
 * @param {string} neteasePlaylistId - NetEase playlist ID
 * @param {string} targetPlaylistId - Local playlist ID to add clips to
 * @returns {{ added: number, skipped: number, notFound: string[] }}
 */
async function importByNetease(neteasePlaylistId, targetPlaylistId) {
  const neteaseSongs = await fetchNeteasePlaylist(neteasePlaylistId);

  if (neteaseSongs.length === 0) {
    return { added: 0, skipped: 0, notFound: [], artistMismatch: [] };
  }

  const mp3BasePath = process.env.MP3_BASE_PATH;
  const clipsBasePath = process.env.CLIPS_BASE_PATH;

  // Get existing clip IDs in target
  const existingClips = await prisma.playlistClip.findMany({
    where: { playlistId: targetPlaylistId },
    select: { clipId: true },
  });
  const existingSet = new Set(existingClips.map((c) => c.clipId));

  // Get max position
  const maxPos = await prisma.playlistClip.aggregate({
    where: { playlistId: targetPlaylistId },
    _max: { position: true },
  });
  let position = (maxPos._max.position ?? -1) + 1;

  let added = 0;
  let skipped = 0;
  const notFound = [];
  const artistMismatch = [];

  for (const neteaseSong of neteaseSongs) {
    const { song, artistMatch } = await findSongInDB(neteaseSong.title, neteaseSong.artist);

    if (!song) {
      notFound.push(`${neteaseSong.title} - ${neteaseSong.artist}`);
      continue;
    }

    if (!artistMatch) {
      artistMismatch.push({ title: neteaseSong.title, externalArtist: neteaseSong.artist, localArtist: song.artist });
    }

    // Determine start time from song's starts field
    const firstStart = song.starts
      ? parseInt(song.starts.split('|')[0], 10)
      : 0;

    // Find or create clip at this start time (prefer global clips)
    let clip = await prisma.clip.findFirst({
      where: { songId: song.id, start: firstStart, isGlobal: true },
    }) || await prisma.clip.findFirst({
      where: { songId: song.id, start: firstStart },
    });

    if (!clip) {
      const clipLyrics = sliceLRC(song.lyrics, firstStart, firstStart + CLIP_LENGTH);
      const clipFilename = buildClipFilename(song.title, song.artist, firstStart);
      const sourcePath = path.join(mp3BasePath, song.filePath);
      const outputPath = path.join(clipsBasePath, clipFilename);

      try {
        clipAudio({ sourcePath, outputPath, start: firstStart, length: CLIP_LENGTH, lyrics: clipLyrics });
      } catch (err) {
        console.warn(`  Warning: Could not clip "${song.title}": ${err.message}`);
      }

      clip = await prisma.clip.create({
        data: {
          songId: song.id,
          start: firstStart,
          length: CLIP_LENGTH,
          filePath: clipFilename,
          lyrics: clipLyrics,
        },
      });
    }

    // Skip if clip already in playlist
    if (existingSet.has(clip.id)) {
      skipped++;
      continue;
    }

    await prisma.playlistClip.create({
      data: { playlistId: targetPlaylistId, clipId: clip.id, position },
    });
    existingSet.add(clip.id);
    position++;
    added++;
  }

  return { added, skipped, notFound, artistMismatch };
}

// CLI usage
if (require.main === module) {
  const [neteaseId, targetId] = process.argv.slice(2);
  if (!neteaseId || !targetId) {
    console.error('Usage: node scripts/import-playlist-by-netease.js <neteasePlaylistId> <targetPlaylistId>');
    process.exit(1);
  }

  importByNetease(neteaseId, targetId)
    .then(({ added, skipped, notFound }) => {
      console.log(`Done. Added: ${added}, Skipped: ${skipped}`);
      if (notFound.length > 0) {
        console.log(`Not found (${notFound.length}):`);
        notFound.forEach((s) => console.log(`  ${s}`));
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { importByNetease, fetchNeteasePlaylist };
