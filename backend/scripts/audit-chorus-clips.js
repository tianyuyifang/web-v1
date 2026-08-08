/** Independent audit: confirm every expected chorus clip exists in DB + on disk. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');
const CLIPS = process.env.CLIPS_BASE_PATH || '/var/www/music/allClips';

const rows = JSON.parse(
  Buffer.from(fs.readFileSync(path.join(__dirname, 'chorus.b64.txt'), 'ascii'), 'base64').toString('utf8')
);
const norm = (s) => (s == null ? '' : String(s).normalize('NFC').trim().toLowerCase());

(async () => {
  const songs = await prisma.song.findMany({ select: { id: true, title: true, filePath: true, starts: true } });
  const byFilePath = new Map(songs.map((s) => [norm(s.filePath), s]));

  let expected = 0, okDb = 0, okMp3 = 0, okLrc = 0, badLen = 0, skippedNoPoint = 0;
  const problems = [];
  for (const r of rows) {
    const song = byFilePath.get(norm(r.file_path));
    if (!song) { problems.push('no song: ' + r.file_path); continue; }
    // floor only — chorus_sec_ceil is ignored by design.
    // Blank chorus cells produce no clip by design — not a missing-clip problem.
    const starts = [r.f].filter((v) => Number.isInteger(v) && v >= 0);
    if (!starts.length) { skippedNoPoint++; continue; }
    for (const start of starts) {
      expected++;
      const clip = await prisma.clip.findFirst({ where: { songId: song.id, start } });
      if (!clip) { problems.push('MISSING clip ' + song.title + ' @' + start); continue; }
      okDb++;
      if (clip.length !== 20) badLen++;
      const f = path.join(CLIPS, clip.filePath);
      if (fs.existsSync(f) && fs.statSync(f).size > 1000) okMp3++;
      else problems.push('MISSING/EMPTY mp3 ' + clip.filePath);
      if (fs.existsSync(f.replace(/\.mp3$/i, '.lrc'))) okLrc++;
      // song.starts must list this start
      const listed = (song.starts || '').split('|').map(Number).includes(start);
      if (!listed) problems.push('start not in song.starts: ' + song.title + ' @' + start);
    }
  }

  console.log('rows skipped (no chorus point):', skippedNoPoint);
  console.log('expected clips:', expected);
  console.log('present in DB :', okDb);
  console.log('mp3 on disk   :', okMp3);
  console.log('lrc on disk   :', okLrc, '(songs without lyrics legitimately have none)');
  console.log('wrong length  :', badLen);
  console.log('problems      :', problems.length);
  for (const p of problems.slice(0, 20)) console.log('  - ' + p);
  await prisma.$disconnect();
})();
