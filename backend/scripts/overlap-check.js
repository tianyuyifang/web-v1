/** Compare new chorus payload against clips already in DB, per song. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');

const rows = JSON.parse(
  Buffer.from(fs.readFileSync(path.join(__dirname, 'chorus.b64.txt'), 'ascii'), 'base64').toString('utf8')
);
const norm = (s) => (s == null ? '' : String(s).normalize('NFC').trim().toLowerCase());

(async () => {
  const songs = await prisma.song.findMany({ select: { id: true, title: true, artist: true, filePath: true } });
  const byFilePath = new Map(songs.map((s) => [norm(s.filePath), s]));

  let bothNew = 0, oneNew = 0, allExist = 0, blank = 0;
  const samples = [];
  for (const r of rows) {
    const song = byFilePath.get(norm(r.file_path));
    if (!song) continue;
    // Both chorus points: floor AND ceil (user rule 2026-11-07, restoring the
    // pre-2026-07-29 behaviour). Deduped because ceil occasionally equals floor,
    // and a Set keeps the two-clip plan from asking for the same clip twice.
    const starts = [...new Set([r.f, r.c].filter((v) => Number.isInteger(v) && v >= 0))]
      .sort((a, b) => a - b);
    if (!starts.length) { blank++; continue; }
    const existing = new Set(
      (await prisma.clip.findMany({ where: { songId: song.id }, select: { start: true } })).map((c) => c.start)
    );
    const missing = starts.filter((s) => !existing.has(s));
    if (missing.length === starts.length) bothNew++;
    else if (missing.length) oneNew++;
    else allExist++;
    if (samples.length < 8 && existing.size) {
      samples.push({
        song: song.title,
        wanted: starts,
        existingStarts: [...existing].sort((a, b) => a - b).slice(0, 12),
      });
    }
  }
  console.log('rows where BOTH points are new :', bothNew);
  console.log('rows where ONE point is new    :', oneNew);
  console.log('rows fully already clipped     :', allExist);
  console.log('rows blank (skipped)           :', blank);
  console.log('\nsample songs (wanted vs already-in-DB starts):');
  for (const s of samples) console.log('  ' + JSON.stringify(s));
  await prisma.$disconnect();
})();
