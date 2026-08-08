/**
 * Force-regenerate clip audio for songs listed in bad-songs.xlsx.
 *
 * update-bad-songs.js refreshes lyrics/duration but does NOT re-cut clip MP3s,
 * so after replacing a song's audio the clips still hold the old audio.
 * Uses clipService.createClip's ADMIN force path, which deletes the old clip
 * file and re-cuts from the new source, bumping clip.version so clients refetch.
 *
 *   node scripts/regen-clips.js [--xlsx /path/to/bad-songs.xlsx]            # dry run
 *   node scripts/regen-clips.js [--xlsx /path/to/bad-songs.xlsx] --apply
 *
 * Defaults to /home/chaol/bad-songs.xlsx (the path the update flow uploads to).
 */
require('dotenv').config();
const XLSX = require('xlsx');
const prisma = require('../src/db/client');
const { createClip } = require('../src/services/clipService');

const APPLY = process.argv.includes('--apply');
const xlsxArg = process.argv.indexOf('--xlsx');
const XLSX_PATH = xlsxArg !== -1 ? process.argv[xlsxArg + 1] : '/home/chaol/bad-songs.xlsx';

(async () => {
  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  const tasks = [];
  for (const r of rows) {
    const song = await prisma.song.findFirst({
      where: { title: r.Title, artist: r.Artist },
      include: { clips: { orderBy: { start: 'asc' } } },
    });
    if (!song) { console.log('NOT FOUND: ' + r.Title + ' / ' + r.Artist); continue; }
    for (const c of song.clips) {
      if (song.duration != null && c.start >= song.duration) {
        console.log(`SKIP (start ${c.start}s >= new duration ${song.duration}s): ${song.title}`);
        continue;
      }
      tasks.push({ song, clip: c });
    }
  }

  console.log(`clips to regenerate: ${tasks.length}`);
  if (!APPLY) {
    for (const t of tasks) console.log(`   ${t.song.title} @${t.clip.start}s v${t.clip.version}`);
    console.log('\nDRY RUN — no changes. Re-run with --apply.');
    await prisma.$disconnect();
    return;
  }

  let done = 0, failed = 0;
  for (const t of tasks) {
    try {
      const updated = await createClip({
        songId: t.song.id,
        start: t.clip.start,
        length: t.clip.length,
        userId: null,
        userRole: 'ADMIN',
        force: true,
      });
      done++;
      console.log(`   ✓ ${t.song.title} @${t.clip.start}s  v${t.clip.version} → v${updated.version}`);
    } catch (err) {
      failed++;
      console.log(`   ✗ ${t.song.title} @${t.clip.start}s — ${err.message}`);
    }
  }
  console.log(`\nregenerated: ${done} | failed: ${failed}`);
  await prisma.$disconnect();
})();
