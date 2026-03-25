/**
 * test-import-to-xlsx.js
 *
 * Dry-run import preview. Scans a directory of MP3 files, extracts metadata
 * (ID3 tags with filename fallback), computes pinyin fields, and exports
 * everything to import-preview.xlsx for manual inspection.
 * Does NOT write to the database.
 *
 * Usage:
 *   node tests/test-import-to-xlsx.js [--dir /path/to/mp3s] [--limit 100]
 *
 * Options:
 *   --dir    Directory to scan (defaults to MP3_BASE_PATH from .env)
 *   --limit  Max number of files to process (default: all)
 *
 * Output: tests/import-preview.xlsx
 *
 * Note: Requires the `xlsx` package. Uninstall after use:
 *   npm uninstall xlsx
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { toPinyin, toPinyinInitials } = require('../src/utils/pinyin');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/**
 * Parses CLI arguments and returns runtime options.
 * Falls back to MP3_BASE_PATH env var for the directory.
 * Exits with code 1 if no directory is resolvable.
 *
 * @returns {{ dir: string, limit: number }}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dir: process.env.MP3_BASE_PATH,
    limit: 0, // 0 = no limit
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) opts.dir = args[++i];
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
  }

  if (!opts.dir) {
    console.error('Error: No MP3 directory. Use --dir or set MP3_BASE_PATH in .env');
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Recursively finds all MP3 files under baseDir.
 *
 * @param {string} baseDir    - Root directory (used to compute relative paths)
 * @param {string} currentDir - Current recursion directory (defaults to baseDir)
 * @returns {string[]} Relative paths to all .mp3 files found
 */
function findMp3Files(baseDir, currentDir = baseDir) {
  const results = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMp3Files(baseDir, fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) {
      results.push(path.relative(baseDir, fullPath));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extracts title, artist, and duration from an MP3 file.
 * Tries ID3 tags first (via music-metadata); falls back to parsing the
 * filename as "Title - Artist" if tags are missing or unreadable.
 *
 * @param {string} baseDir      - Root MP3 directory
 * @param {string} relativePath - Path to the file relative to baseDir
 * @returns {Promise<{ title: string, artist: string, duration: number|null, filePath: string, metadataSource: 'ID3'|'filename' }>}
 */
async function extractMetadata(baseDir, relativePath) {
  const fullPath = path.join(baseDir, relativePath);
  const basename = path.basename(relativePath, '.mp3');

  let title = null;
  let artist = null;
  let duration = null;
  let metadataSource = 'filename';

  try {
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(fullPath);

    title = metadata.common.title || null;
    artist = metadata.common.artist || null;
    duration = metadata.format.duration
      ? Math.round(metadata.format.duration)
      : null;

    if (title && artist) metadataSource = 'ID3';
  } catch (err) {
    // fall through to filename parsing
  }

  if (!title || !artist) {
    const parts = basename.split(' - ');
    if (parts.length >= 2) {
      title = title || parts[0].trim();
      artist = artist || parts.slice(1).join(' - ').trim();
    } else {
      title = title || basename.trim();
      artist = artist || 'Unknown';
    }
  }

  return { title, artist, duration, filePath: relativePath, metadataSource };
}

// ---------------------------------------------------------------------------
// Lyrics check
// ---------------------------------------------------------------------------

/**
 * Checks whether a matching .lrc lyrics file exists alongside the MP3.
 *
 * @param {string} baseDir      - Root MP3 directory
 * @param {string} relativePath - Path to the .mp3 file relative to baseDir
 * @returns {boolean} True if a .lrc file with the same basename exists
 */
function hasLrcFile(baseDir, relativePath) {
  const lrcPath = path.join(baseDir, relativePath.replace(/\.mp3$/i, '.lrc'));
  return fs.existsSync(lrcPath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point. Scans MP3s, extracts metadata, and writes import-preview.xlsx.
 * Prints a summary (total, ID3 vs filename, lyrics count, errors) on completion.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const opts = parseArgs();
  console.log(`Scanning: ${opts.dir}`);

  if (!fs.existsSync(opts.dir)) {
    console.error(`Error: Directory not found: ${opts.dir}`);
    process.exit(1);
  }

  let mp3Files = findMp3Files(opts.dir);
  console.log(`Found ${mp3Files.length} MP3 files`);

  if (opts.limit > 0) {
    mp3Files = mp3Files.slice(0, opts.limit);
    console.log(`Limiting to first ${opts.limit} files`);
  }

  if (mp3Files.length === 0) {
    console.log('No MP3 files found.');
    return;
  }

  const rows = [];
  let processed = 0;

  for (const relativePath of mp3Files) {
    try {
      const meta = await extractMetadata(opts.dir, relativePath);
      const hasLyrics = hasLrcFile(opts.dir, relativePath);
      const artistsSplit = meta.artist.split('_').map((a) => a.trim()).filter(Boolean);

      rows.push({
        filePath: meta.filePath,
        title: meta.title,
        artist: meta.artist,
        duration: meta.duration,
        durationFormatted: meta.duration
          ? `${Math.floor(meta.duration / 60)}:${String(meta.duration % 60).padStart(2, '0')}`
          : '',
        metadataSource: meta.metadataSource,
        hasLyrics: hasLyrics ? 'Yes' : 'No',
        titlePinyin: toPinyin(meta.title) || '',
        titlePinyinInitials: toPinyinInitials(meta.title) || '',
        artistPinyin: toPinyin(meta.artist) || '',
        artistPinyinInitials: toPinyinInitials(meta.artist) || '',
        artistCount: artistsSplit.length,
        artistsSplit: artistsSplit.join(' | '),
      });

      processed++;
      if (processed % 500 === 0) {
        console.log(`  Processed ${processed}/${mp3Files.length}...`);
      }
    } catch (err) {
      rows.push({
        filePath: relativePath,
        title: `ERROR: ${err.message}`,
        artist: '', duration: '', durationFormatted: '',
        metadataSource: 'error', hasLyrics: '',
        titlePinyin: '', titlePinyinInitials: '',
        artistPinyin: '', artistPinyinInitials: '',
        artistCount: '', artistsSplit: '',
      });
    }
  }

  // Write to xlsx
  const ws = XLSX.utils.json_to_sheet(rows);

  // Set column widths for readability
  ws['!cols'] = [
    { wch: 50 },  // filePath
    { wch: 30 },  // title
    { wch: 25 },  // artist
    { wch: 8 },   // duration
    { wch: 8 },   // durationFormatted
    { wch: 10 },  // metadataSource
    { wch: 8 },   // hasLyrics
    { wch: 35 },  // titlePinyin
    { wch: 15 },  // titlePinyinInitials
    { wch: 25 },  // artistPinyin
    { wch: 15 },  // artistPinyinInitials
    { wch: 8 },   // artistCount
    { wch: 30 },  // artistsSplit
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Songs');

  const outputPath = path.join(__dirname, 'import-preview.xlsx');
  XLSX.writeFile(wb, outputPath);

  console.log(`\nDone. Processed ${processed} files.`);
  console.log(`Output: ${outputPath}`);

  // Summary
  const withLyrics = rows.filter((r) => r.hasLyrics === 'Yes').length;
  const fromId3 = rows.filter((r) => r.metadataSource === 'ID3').length;
  const errors = rows.filter((r) => r.metadataSource === 'error').length;
  const multiArtist = rows.filter((r) => r.artistCount > 1).length;
  console.log(`\n--- Summary ---`);
  console.log(`  Total: ${rows.length}`);
  console.log(`  Metadata from ID3: ${fromId3}`);
  console.log(`  Metadata from filename: ${rows.length - fromId3 - errors}`);
  console.log(`  With lyrics (.lrc): ${withLyrics}`);
  console.log(`  Multi-artist songs: ${multiArtist}`);
  console.log(`  Errors: ${errors}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
