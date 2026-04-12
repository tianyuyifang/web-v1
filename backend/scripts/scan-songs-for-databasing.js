/**
 * Scan songs and import them into the database.
 *
 * Scans the directory recursively for .mp3 files, extracts metadata
 * (title, artist, duration) from ID3 tags or filename, loads matching
 * .lrc lyrics files, generates pinyin columns, batch-inserts into
 * the songs and song_artists tables, and creates a default clip
 * (audio file + sliced lyrics) for each song using its first lyric timestamp.
 *
 * Usage:
 *   node scripts/scan-songs-for-databasing.js [--dir /path/to/mp3s] [--batch 500] [--dry-run]
 *
 * Options:
 *   --dir       MP3 directory (defaults to MP3_BASE_PATH from .env)
 *   --batch     Batch size for inserts (default 500)
 *   --dry-run   Parse and log but don't write to DB
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { toPinyin, toPinyinInitials, toPinyinConcat, toPinyinAll, toPinyinInitialsAll } = require('../src/utils/pinyin');
const { sliceLRC } = require('../src/utils/lrc');
const { clipAudio } = require('./clip-audio');

const prisma = new PrismaClient();
const CLIP_LENGTH = 20;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dir: process.env.MP3_BASE_PATH,
    batch: 500,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) opts.dir = args[++i];
    if (args[i] === '--batch' && args[i + 1]) opts.batch = parseInt(args[++i], 10);
    if (args[i] === '--dry-run') opts.dryRun = true;
  }

  if (!opts.dir) {
    console.error('Error: No MP3 directory specified. Use --dir or set MP3_BASE_PATH in .env');
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Recursively find all .mp3 files in a directory.
 * Returns relative paths from the base directory.
 */
function findMp3Files(baseDir, currentDir = baseDir) {
  const results = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMp3Files(baseDir, fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) {
      // Store path relative to baseDir (used as filePath in DB)
      results.push(path.relative(baseDir, fullPath));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extract metadata from an MP3 file using music-metadata.
 * Falls back to parsing the filename if ID3 tags are missing.
 *
 * Filename convention: "Title - Artist.mp3"
 * Multi-artist: "Title - Artist1_Artist2.mp3"
 */
async function extractMetadata(baseDir, relativePath) {
  const fullPath = path.join(baseDir, relativePath);
  const basename = path.basename(relativePath, '.mp3');

  let title = null;
  let artist = null;
  let duration = null;

  // Try ID3 tags first
  try {
    // Dynamic import because music-metadata is ESM-only in v7+
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(fullPath);

    title = metadata.common.title || null;
    artist = metadata.common.artist || null;
    duration = metadata.format.duration
      ? Math.round(metadata.format.duration)
      : null;
  } catch (err) {
    // music-metadata failed — fall back to filename
    console.warn(`  Warning: Could not read ID3 tags for ${relativePath}: ${err.message}`);
  }

  // Fallback: parse from filename "Title - Artist.mp3"
  let usedFallback = false;
  if (!title || !artist) {
    usedFallback = true;
    const parts = basename.split(' - ');
    if (parts.length >= 2) {
      title = title || parts[0].trim();
      artist = artist || parts.slice(1).join(' - ').trim();
    } else {
      // No separator — use whole filename as title, artist unknown
      title = title || basename.trim();
      artist = artist || 'Unknown';
    }
  }

  return { title, artist, duration, filePath: relativePath, usedFallback };
}

// ---------------------------------------------------------------------------
// Lyrics loading
// ---------------------------------------------------------------------------

/**
 * Look for an .lrc file matching the MP3 file and load its contents.
 * Checks for: same basename with .lrc extension, in the same directory.
 *
 * e.g. "月亮代表我的心 - 邓丽君.mp3" → "月亮代表我的心 - 邓丽君.lrc"
 */
function loadLyrics(baseDir, relativePath) {
  const lrcPath = path.join(
    baseDir,
    relativePath.replace(/\.mp3$/i, '.lrc')
  );

  try {
    if (fs.existsSync(lrcPath)) {
      return fs.readFileSync(lrcPath, 'utf-8');
    }
  } catch (err) {
    console.warn(`  Warning: Could not read LRC file ${lrcPath}: ${err.message}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Song processing
// ---------------------------------------------------------------------------

/**
 * Build a song record with pinyin columns and split artists.
 */
function getFirstLyricStart(lyrics) {
  if (!lyrics) return null;
  const match = lyrics.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
  if (!match) return null;
  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  return minutes * 60 + seconds; // floor to nearest whole second before
}

function processSong(metadata, lyrics) {
  const { title, artist, duration, filePath } = metadata;

  // Pinyin for title
  const titlePinyin = toPinyin(title);
  const titlePinyinInitials = toPinyinInitials(title);
  const titlePinyinConcat = toPinyinConcat(title);
  const titlePinyinAll = toPinyinAll(title);
  const titlePinyinInitialsAll = toPinyinInitialsAll(title);

  // Pinyin for combined artist string
  const artistPinyin = toPinyin(artist);
  const artistPinyinInitials = toPinyinInitials(artist);
  const artistPinyinConcat = toPinyinConcat(artist);
  const artistPinyinAll = toPinyinAll(artist);
  const artistPinyinInitialsAll = toPinyinInitialsAll(artist);

  // Split artists by "_" for the song_artists table
  const artistNames = artist.split('_').map((a) => a.trim()).filter(Boolean);
  const artists = artistNames.map((name, position) => ({
    artistName: name,
    artistPinyin: toPinyin(name),
    artistPinyinInitials: toPinyinInitials(name),
    artistPinyinConcat: toPinyinConcat(name),
    artistPinyinAll: toPinyinAll(name),
    artistPinyinInitialsAll: toPinyinInitialsAll(name),
    position,
  }));

  // Use first lyric timestamp as the initial start time
  const firstStart = getFirstLyricStart(lyrics);
  const starts = firstStart !== null ? String(firstStart) : null;

  return {
    song: {
      title,
      artist,
      duration,
      filePath,
      lyrics,
      starts,
      titlePinyin,
      titlePinyinInitials,
      titlePinyinConcat,
      titlePinyinAll,
      titlePinyinInitialsAll,
      artistPinyin,
      artistPinyinInitials,
      artistPinyinConcat,
      artistPinyinAll,
      artistPinyinInitialsAll,
    },
    artists,
  };
}

// ---------------------------------------------------------------------------
// Clip helpers
// ---------------------------------------------------------------------------

function buildClipFilename(title, artist, start) {
  const artists = artist.split('_').map((a) => a.trim()).join(' & ');
  const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '_');
  return `${safe(title)} - ${safe(artists)} - ${start}.mp3`;
}

// ---------------------------------------------------------------------------
// Database insertion
// ---------------------------------------------------------------------------

/**
 * Insert a batch of songs, their artists, and a default clip into the database.
 * Uses a transaction for songs + artists, then creates clips with audio files.
 */
async function insertBatch(batch, opts) {
  const createdSongs = [];

  await prisma.$transaction(async (tx) => {
    for (const { song, artists } of batch) {
      const created = await tx.song.create({ data: song });

      if (artists.length > 0) {
        await tx.songArtist.createMany({
          data: artists.map((a) => ({ ...a, songId: created.id })),
        });
      }

      createdSongs.push({ ...created, _lyrics: song.lyrics });
    }
  });

  // Create default clips for songs that have a first start
  if (!opts.dryRun) {
    const clipsDir = process.env.CLIPS_BASE_PATH;
    for (const song of createdSongs) {
      if (!song.starts) continue;
      const start = parseInt(song.starts.split('|')[0], 10);
      if (isNaN(start)) continue;

      const clipLyrics = sliceLRC(song._lyrics, start, start + CLIP_LENGTH);
      const clipFilename = buildClipFilename(song.title, song.artist, start);
      const sourcePath = path.join(opts.dir, song.filePath);
      const outputPath = path.join(clipsDir, clipFilename);

      try {
        clipAudio({
          sourcePath,
          outputPath,
          start,
          length: CLIP_LENGTH,
          lyrics: clipLyrics,
        });

        await prisma.clip.create({
          data: {
            songId: song.id,
            start,
            length: CLIP_LENGTH,
            filePath: clipFilename,
            lyrics: clipLyrics,
          },
        });
      } catch (err) {
        console.warn(`  Warning: Could not create clip for "${song.title}" at ${start}s: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  console.log(`Scanning for MP3 files in: ${opts.dir}`);
  console.log(`Batch size: ${opts.batch}`);
  if (opts.dryRun) console.log('DRY RUN — no database writes');

  // Check directory exists
  if (!fs.existsSync(opts.dir)) {
    console.error(`Error: Directory not found: ${opts.dir}`);
    process.exit(1);
  }

  // Find all MP3 files
  const mp3Files = findMp3Files(opts.dir);
  const total = mp3Files.length;
  console.log(`Found ${total} MP3 files`);

  if (total === 0) {
    console.log('Nothing to import.');
    return;
  }

  // Check for duplicates already in DB
  const existingPaths = new Set(
    (await prisma.song.findMany({ select: { filePath: true } }))
      .map((s) => s.filePath)
  );
  const newFiles = mp3Files.filter((f) => !existingPaths.has(f));
  console.log(`Skipping ${total - newFiles.length} already-imported songs`);
  console.log(`Importing ${newFiles.length} new songs...`);

  let imported = 0;
  let failed = 0;
  let batch = [];
  const fallbackSongs = [];

  for (const relativePath of newFiles) {
    try {
      const metadata = await extractMetadata(opts.dir, relativePath);
      if (metadata.usedFallback) fallbackSongs.push({ file: relativePath, title: metadata.title, artist: metadata.artist });
      const lyrics = loadLyrics(opts.dir, relativePath);
      const processed = processSong(metadata, lyrics);
      batch.push(processed);

      // Flush batch when full
      if (batch.length >= opts.batch) {
        if (!opts.dryRun) {
          await insertBatch(batch, opts);
        }
        imported += batch.length;
        batch = [];
        console.log(`  Imported ${imported}/${newFiles.length} songs...`);
      }
    } catch (err) {
      failed++;
      console.error(`  Error processing ${relativePath}: ${err.message}`);
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    if (!opts.dryRun) {
      await insertBatch(batch, opts);
    }
    imported += batch.length;
  }

  console.log('\n--- Import complete ---');
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped (already in DB): ${total - newFiles.length}`);
  console.log(`  Failed: ${failed}`);

  if (fallbackSongs.length > 0) {
    console.log(`\n--- Songs using filename fallback (no ID3 tags): ${fallbackSongs.length} ---`);
    for (const s of fallbackSongs) {
      console.log(`  [${s.file}]`);
      console.log(`    Title: ${s.title}`);
      console.log(`    Artist: ${s.artist}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
