/**
 * import-playlist-by-file.js
 *
 * Reads an xlsx file with columns (title, artist), matches songs in the DB,
 * creates clips at each song's default start time if they don't exist,
 * and adds them to the target playlist.
 *
 * Usage: node scripts/import-playlist-by-file.js <xlsxFilePath> <targetPlaylistId>
 *
 * XLSX format:
 *   Column A: title (song title, e.g. "小情歌")
 *   Column B: artist (artist name, e.g. "苏打绿")
 *
 * Exports importByFile() for use by API routes.
 */

require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');
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
 * Parse an xlsx buffer or file path into an array of { title, artist }.
 *
 * @param {Buffer|string} input - xlsx file buffer or file path
 * @returns {{ title: string, artist: string }[]}
 */
function parseXlsx(input) {
  const workbook = Buffer.isBuffer(input)
    ? XLSX.read(input, { type: 'buffer' })
    : XLSX.readFile(input);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows
    .map((row) => ({
      title: (row.title || row.Title || row['标题'] || '').toString().trim(),
      artist: (row.artist || row.Artist || row['歌手'] || '').toString().trim(),
    }))
    .filter((r) => r.title);
}

/**
 * Import clips from an xlsx file into a playlist.
 *
 * @param {Buffer|string} input - xlsx buffer or file path
 * @param {string} targetPlaylistId - playlist to add clips to
 * @returns {{ added: number, skipped: number, notFound: string[] }}
 */
async function importByFile(input, targetPlaylistId) {
  const entries = parseXlsx(input);
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

  for (const entry of entries) {
    // Match song by title + artist
    const song = await prisma.song.findFirst({
      where: {
        title: { equals: entry.title, mode: 'insensitive' },
        ...(entry.artist
          ? { artist: { contains: entry.artist, mode: 'insensitive' } }
          : {}),
      },
    });

    if (!song) {
      notFound.push(`${entry.title} - ${entry.artist}`);
      continue;
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

  return { added, skipped, notFound };
}

// CLI usage
if (require.main === module) {
  const [filePath, targetId] = process.argv.slice(2);
  if (!filePath || !targetId) {
    console.error('Usage: node scripts/import-playlist-by-file.js <xlsxFile> <targetPlaylistId>');
    process.exit(1);
  }

  importByFile(filePath, targetId)
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

module.exports = { importByFile };
