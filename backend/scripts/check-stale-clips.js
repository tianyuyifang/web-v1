/** Report clips of the updated songs whose audio predates the new MP3. Read-only. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const prisma = require('../src/db/client');

const MP3_BASE = process.env.MP3_BASE_PATH || '/var/www/music/allSongs';
const CLIPS_BASE = process.env.CLIPS_BASE_PATH || '/var/www/music/allClips';

const xlsxArg = process.argv.indexOf('--xlsx');
const XLSX_PATH = xlsxArg !== -1 ? process.argv[xlsxArg + 1] : '/home/chaol/bad-songs.xlsx';

(async () => {
  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  for (const r of rows) {
    const song = await prisma.song.findFirst({
      where: { title: r.Title, artist: r.Artist },
      include: { clips: { orderBy: { start: 'asc' } } },
    });
    if (!song) { console.log('NOT FOUND: ' + r.Title); continue; }

    const mp3Path = path.join(MP3_BASE, song.filePath);
    const mp3Mtime = fs.existsSync(mp3Path) ? fs.statSync(mp3Path).mtimeMs : null;

    console.log(`\n${song.title} — ${song.artist}  (duration ${song.duration}s, ${song.clips.length} clip(s))`);
    for (const c of song.clips) {
      const cp = path.join(CLIPS_BASE, c.filePath || '');
      const exists = c.filePath && fs.existsSync(cp);
      const clipMtime = exists ? fs.statSync(cp).mtimeMs : null;
      const stale = clipMtime != null && mp3Mtime != null && clipMtime < mp3Mtime;
      const past = song.duration != null && c.start >= song.duration;
      console.log(
        `   clip start=${c.start}s len=${c.length}s  file=${exists ? 'yes' : 'MISSING'}` +
        `  ${stale ? 'STALE (older than new mp3)' : 'fresh'}` +
        `${past ? '  !! start >= new duration' : ''}`
      );
    }
  }
  await prisma.$disconnect();
})();
