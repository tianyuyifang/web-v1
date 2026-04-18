/**
 * import-playlist-by-qq.js
 *
 * Scrapes a QQ Music playlist by ID, matches songs against the local DB,
 * creates clips if needed, and adds them to the target playlist.
 *
 * Usage: node scripts/import-playlist-by-qq.js <qqPlaylistId> <targetPlaylistId>
 *
 * Exports importByQQ() for use by API routes.
 */

require('dotenv').config();
const { execFile } = require('child_process');
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
 * Call qq-playlist.py to scrape a QQ Music playlist.
 *
 * @param {string} qqPlaylistId
 * @returns {Promise<{ title: string, artist: string }[]>}
 */
function fetchQQPlaylist(qqPlaylistId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'tests', 'qq-playlist.py');

    execFile('python', ['-u', scriptPath, qqPlaylistId], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`QQ Music scraper failed: ${err.message}`));
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          return reject(new Error(result.error));
        }
        resolve(result);
      } catch (e) {
        reject(new Error('Could not parse QQ Music scraper output'));
      }
    });
  });
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
    const qqArtists = artist.split('_').map((a) => a.trim().toLowerCase());
    for (const song of songs) {
      const dbArtists = song.artist.split('_').map((a) => a.trim().toLowerCase());
      const hasMatch = qqArtists.some((qa) =>
        dbArtists.some((da) => da.includes(qa) || qa.includes(da))
      );
      if (hasMatch) return { song, artistMatch: true };
    }
  }

  return songs.length === 1 ? { song: songs[0], artistMatch: false } : { song: null, artistMatch: false };
}

/**
 * Import songs from a QQ Music playlist into a local playlist.
 *
 * @param {string} qqPlaylistId - QQ Music playlist ID
 * @param {string} targetPlaylistId - Local playlist ID to add clips to
 * @returns {{ added: number, skipped: number, notFound: string[] }}
 */
async function importByQQ(qqPlaylistId, targetPlaylistId) {
  const qqSongs = await fetchQQPlaylist(qqPlaylistId);

  if (qqSongs.length === 0) {
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

  for (const qqSong of qqSongs) {
    const { song, artistMatch } = await findSongInDB(qqSong.title, qqSong.artist);

    if (!song) {
      notFound.push(`${qqSong.title} - ${qqSong.artist}`);
      continue;
    }

    if (!artistMatch) {
      artistMismatch.push({ title: qqSong.title, externalArtist: qqSong.artist, localArtist: song.artist });
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
  const [qqId, targetId] = process.argv.slice(2);
  if (!qqId || !targetId) {
    console.error('Usage: node scripts/import-playlist-by-qq.js <qqPlaylistId> <targetPlaylistId>');
    process.exit(1);
  }

  importByQQ(qqId, targetId)
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

module.exports = { importByQQ, fetchQQPlaylist };
