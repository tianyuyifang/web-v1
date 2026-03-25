/**
 * update-bad-songs.js
 *
 * PURPOSE:
 *   Batch-update songs in the database whose MP3 or LRC files have been
 *   replaced (e.g. better audio quality, re-synced lyrics). Looks up each
 *   song by title + artist, reloads the LRC from disk, updates the song row,
 *   and re-slices clip lyrics for all existing clips of that song.
 *
 *   Safe to run at any time — song IDs never change, so all clip, playlist,
 *   and like references remain intact.
 *
 * STEP-BY-STEP INSTRUCTIONS:
 *   1. Replace the MP3 and/or LRC files on disk in the music/allSongs folder.
 *      Keep the same filenames — the script reads from the path already stored
 *      in the database (songs.file_path).
 *
 *   2. Create an xlsx file listing the songs to update. Place it anywhere and
 *      pass its path via --xlsx. Required columns (case-sensitive):
 *        - Title    : exact song title as stored in the database
 *        - Artist   : artist string as stored in the database, multiple artists
 *                     joined with '_' (e.g. "周杰伦_费玉清")
 *
 *   3. Run the script:
 *        node scripts/update-bad-songs.js --xlsx /path/to/songs.xlsx
 *
 *      Optional flags:
 *        --dry-run   Preview what would be updated without writing to the DB
 *
 *   4. Review the printed report:
 *        ✓  Updated successfully
 *        ⚠  Not found  — title/artist in xlsx does not match any DB record
 *        ⚠  No LRC     — MP3 was replaced but no matching .lrc file found on disk
 *        ⚠  Failed     — unexpected error during update
 *
 *   5. Fix any warnings (typos in xlsx, missing LRC files) and re-run if needed.
 *      Re-running is safe — already-correct songs will just be updated again.
 *
 * WHAT IS UPDATED:
 *   - songs.lyrics        — reloaded from the .lrc file on disk
 *   - songs.duration      — re-read from the MP3 file via music-metadata
 *   - clips.lyrics        — re-sliced from the new LRC for each existing clip
 *
 * WHAT IS NOT TOUCHED:
 *   - songs.id, songs.file_path, songs.title, songs.artist, pinyin columns
 *   - clips.start, clips.length, clips.file_path
 *   - playlist_clips, likes — all references remain valid
 *
 * USAGE:
 *   node scripts/update-bad-songs.js --xlsx ./scripts/songs-to-update.xlsx [--dry-run]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const prisma = require('../src/db/client');
const { sliceLRC } = require('../src/utils/lrc');

const CLIP_LENGTH = 20;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { xlsx: null, dryRun: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--xlsx' && args[i + 1]) opts.xlsx = args[++i];
    if (args[i] === '--dry-run') opts.dryRun = true;
  }

  if (!opts.xlsx) {
    console.error('Error: --xlsx <path> is required');
    console.error('Usage: node scripts/update-bad-songs.js --xlsx ./songs-to-update.xlsx [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(opts.xlsx)) {
    console.error(`Error: File not found: ${opts.xlsx}`);
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Read xlsx
// ---------------------------------------------------------------------------

function readXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);

  if (!rows.length) {
    console.error('Error: xlsx file is empty');
    process.exit(1);
  }

  const first = rows[0];
  if (!('Title' in first) || !('Artist' in first)) {
    console.error('Error: xlsx must have "Title" and "Artist" columns');
    process.exit(1);
  }

  return rows.map((r) => ({
    title: String(r.Title).trim(),
    artist: String(r.Artist).trim(),
  }));
}

// ---------------------------------------------------------------------------
// Duration re-read
// ---------------------------------------------------------------------------

async function readDuration(fullPath) {
  try {
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(fullPath);
    return metadata.format.duration ? Math.round(metadata.format.duration) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Update one song
// ---------------------------------------------------------------------------

async function updateSong({ title, artist }, opts) {
  // 1. Find song by title + artist
  const song = await prisma.song.findFirst({
    where: { title: { equals: title, mode: 'insensitive' }, artist: { equals: artist, mode: 'insensitive' } },
  });
  if (!song) {
    return { status: 'not_found' };
  }

  // 2. Load new LRC from disk
  const lrcPath = path.join(
    process.env.MP3_BASE_PATH,
    song.filePath.replace(/\.mp3$/i, '.lrc')
  );
  const newLyrics = fs.existsSync(lrcPath) ? fs.readFileSync(lrcPath, 'utf-8') : null;

  // 3. Re-read duration from MP3
  const mp3Path = path.join(process.env.MP3_BASE_PATH, song.filePath);
  const newDuration = fs.existsSync(mp3Path) ? await readDuration(mp3Path) : null;

  if (opts.dryRun) {
    return {
      status: 'dry_run',
      id: song.id,
      hasLrc: !!newLyrics,
      oldDuration: song.duration,
      newDuration,
    };
  }

  // 4. Update song row
  await prisma.song.update({
    where: { id: song.id },
    data: {
      lyrics: newLyrics,
      ...(newDuration !== null && { duration: newDuration }),
    },
  });

  // 5. Re-slice lyrics for all existing clips
  const clips = await prisma.clip.findMany({ where: { songId: song.id } });
  for (const clip of clips) {
    const clipLyrics = sliceLRC(newLyrics, clip.start, clip.start + clip.length);
    await prisma.clip.update({
      where: { id: clip.id },
      data: { lyrics: clipLyrics },
    });
  }

  return {
    status: 'updated',
    id: song.id,
    hasLrc: !!newLyrics,
    clipsUpdated: clips.length,
    oldDuration: song.duration,
    newDuration,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const rows = readXlsx(opts.xlsx);

  console.log(`Loaded ${rows.length} songs from xlsx`);
  if (opts.dryRun) console.log('DRY RUN — no database writes\n');

  const results = { updated: [], not_found: [], no_lrc: [], failed: [] };

  for (const row of rows) {
    try {
      const result = await updateSong(row, opts);

      if (result.status === 'not_found') {
        results.not_found.push(row);
        console.log(`  ⚠  Not found   | ${row.title} — ${row.artist}`);
      } else {
        if (!result.hasLrc) results.no_lrc.push(row);
        results.updated.push(row);
        const durationNote = result.newDuration !== result.oldDuration
          ? ` | duration ${result.oldDuration}s → ${result.newDuration}s`
          : '';
        const lrcNote = result.hasLrc ? '' : ' | ⚠ no LRC file found';
        const clipsNote = result.status === 'dry_run'
          ? ' | dry run'
          : ` | ${result.clipsUpdated} clip(s) re-sliced`;
        console.log(`  ✓  ${result.status === 'dry_run' ? 'Would update' : 'Updated'}   | ${row.title} — ${row.artist}${durationNote}${clipsNote}${lrcNote}`);
      }
    } catch (err) {
      results.failed.push(row);
      console.error(`  ✗  Failed      | ${row.title} — ${row.artist} : ${err.message}`);
    }
  }

  console.log('\n--- Update complete ---');
  console.log(`  Updated:   ${results.updated.length}`);
  console.log(`  Not found: ${results.not_found.length}`);
  console.log(`  No LRC:    ${results.no_lrc.length}`);
  console.log(`  Failed:    ${results.failed.length}`);

  if (results.not_found.length > 0) {
    console.log('\nNot found (check title/artist spelling in xlsx):');
    results.not_found.forEach((r) => console.log(`  - ${r.title} — ${r.artist}`));
  }

  if (results.no_lrc.length > 0) {
    console.log('\nNo LRC file found on disk (lyrics not updated):');
    results.no_lrc.forEach((r) => console.log(`  - ${r.title} — ${r.artist}`));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Fatal error:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
