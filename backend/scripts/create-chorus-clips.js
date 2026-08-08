/**
 * create-chorus-clips.js — batch-create chorus clips from chorus_points.xlsx.
 *
 * Matches each row to a song by filePath, then creates a single 20s clip at
 * chorus_sec_floor. chorus_sec_ceil is ignored by design (user rule 2026-07-29).
 * Rows with a blank/malformed floor are skipped and reported.
 *
 * Delegates to the app's own clipService.createClip so the resulting clips
 * (ffmpeg cut, sliced .lrc, song.starts update) are identical to UI-created
 * ones. createClip is idempotent: an existing clip at the same start is
 * returned as-is rather than duplicated.
 *
 * Run from backend/ so .env (DATABASE_URL, MP3_BASE_PATH, CLIPS_BASE_PATH) loads:
 *   node scripts/create-chorus-clips.js            # dry run, prints plan only
 *   node scripts/create-chorus-clips.js --apply    # actually create
 *   node scripts/create-chorus-clips.js --apply --limit=2   # smoke test first
 *
 * Expects chorus.b64.txt (base64 of the JSON rows) next to this script.
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');
const { createClip } = require('../src/services/clipService');

const APPLY = process.argv.includes('--apply');
const LENGTH = 20;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

// Payload is base64 so Chinese titles survive scp/ssh transport intact.
const rows = JSON.parse(
  Buffer.from(fs.readFileSync(path.join(__dirname, 'chorus.b64.txt'), 'ascii'), 'base64').toString('utf8')
);
const norm = (s) => (s == null ? '' : String(s).normalize('NFC').trim().toLowerCase());

(async () => {
  const songs = await prisma.song.findMany({ select: { id: true, title: true, artist: true, filePath: true } });
  const byFilePath = new Map(songs.map((s) => [norm(s.filePath), s]));

  const tasks = [];
  const unmatched = [];
  const noPoint = [];
  for (const r of rows) {
    const song = byFilePath.get(norm(r.file_path));
    if (!song) { unmatched.push(r); continue; }
    // Only chorus_sec_floor is used; chorus_sec_ceil is ignored by design.
    // A blank/malformed floor means no clip for this row.
    const starts = [r.f].filter((v) => Number.isInteger(v) && v >= 0);
    if (!starts.length) { noPoint.push(r); continue; }
    for (const start of starts) tasks.push({ song, start });
  }

  if (LIMIT) tasks.splice(LIMIT);

  console.log('rows:', rows.length, '| matched songs:', rows.length - unmatched.length, '| clip tasks:', tasks.length + (LIMIT ? ' (limited to ' + LIMIT + ')' : ''));
  if (unmatched.length) {
    console.log('UNMATCHED (skipped):');
    for (const r of unmatched) console.log('  ' + JSON.stringify({ title: r.title, file_path: r.file_path }));
  }
  if (noPoint.length) {
    console.log('NO CHORUS POINT (skipped):');
    for (const r of noPoint) console.log('  ' + JSON.stringify({ title: r.title, artist: r.artist, f: r.f, c: r.c }));
  }
  if (!APPLY) {
    console.log('\nDRY RUN — no changes made. Re-run with --apply to create.');
    await prisma.$disconnect();
    return;
  }

  let created = 0, reused = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < tasks.length; i++) {
    const { song, start } = tasks[i];
    try {
      const before = await prisma.clip.findFirst({ where: { songId: song.id, start } });
      await createClip({ songId: song.id, start, length: LENGTH, userId: null, userRole: 'ADMIN', force: false });
      if (before) reused++; else created++;
    } catch (err) {
      failed++;
      failures.push({ title: song.title, artist: song.artist, start, error: err.message });
    }
    if ((i + 1) % 25 === 0 || i === tasks.length - 1) {
      console.log(`  progress ${i + 1}/${tasks.length} — created:${created} reused:${reused} failed:${failed}`);
    }
  }

  console.log('\n=== DONE ===');
  console.log('created:', created, '| already existed:', reused, '| failed:', failed);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  ' + JSON.stringify(f));
  }
  await prisma.$disconnect();
})();
