/**
 * Put back clip audio files that went missing, without touching any row.
 *
 * A clip whose file is gone still appears in every playlist holding it and
 * still shows its likes — pressing play just returns 404 and the song is
 * silent, with nothing to say why. Three clips are in that state, across six
 * playlists belonging to five different people.
 *
 * Two causes, two repairs:
 *
 *   case  the file is on disk under a name differing only in case. Windows
 *         treats that as found and Linux does not, so it plays in development
 *         and 404s in production. Renaming the file to match the row fixes it —
 *         that direction rather than the other because the row already matches
 *         what clipService would generate, so changing the row instead would
 *         come apart again the next time a clip is regenerated.
 *
 *   recut the file is genuinely gone. The source mp3 is still there and
 *         predates the surviving clips of the same song, so cutting again at
 *         the recorded start reproduces the original audio.
 *
 * Nothing here writes to the database. The clip rows are already correct; only
 * the files are missing, so only files are restored. Playlist positions, likes
 * and clip ids are untouched by construction.
 *
 * Usage:
 *   node scripts/repair-missing-clips.js            # dry run
 *   node scripts/repair-missing-clips.js --apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const prisma = require('../src/db/client');
const { clipAudio } = require('./clip-audio');

const APPLY = process.argv.includes('--apply');
const CLIPS = config.clipsBasePath;
const MP3 = config.mp3BasePath;

/**
 * Exact, case-sensitive presence check.
 *
 * fs.existsSync answers case-insensitively on Windows, which is what let these
 * three clips look fine locally while 404ing in production. Comparing against
 * the directory listing gives the same answer on both platforms.
 */
function listing(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

(async () => {
  console.log(APPLY ? '=== 执行模式 ===' : '=== 预演 (DRY RUN) —— 不会做任何改动 ===\n');

  const clips = await prisma.clip.findMany({
    select: {
      id: true, start: true, length: true, filePath: true, lyrics: true,
      song: { select: { title: true, artist: true, filePath: true, duration: true } },
    },
  });

  const files = listing(CLIPS);
  const exact = new Set(files);
  const byLower = new Map();
  for (const f of files) byLower.set(f.toLowerCase(), f);

  const broken = clips.filter((c) => c.filePath && !exact.has(c.filePath));
  console.log(`文件缺失的 clip: ${broken.length}\n`);

  const plans = [];
  for (const c of broken) {
    const onDisk = byLower.get(c.filePath.toLowerCase());
    const srcPath = path.join(MP3, c.song.filePath);
    const srcOk = fs.existsSync(srcPath);

    if (onDisk) {
      plans.push({ kind: 'case', clip: c, from: onDisk, to: c.filePath });
    } else if (!srcOk) {
      plans.push({ kind: 'blocked', clip: c, why: '源 mp3 也不在: ' + c.song.filePath });
    } else if (c.song.duration != null && c.start >= c.song.duration) {
      plans.push({ kind: 'blocked', clip: c, why: `起点 ${c.start}s 超出时长 ${c.song.duration}s` });
    } else {
      plans.push({ kind: 'recut', clip: c, srcPath });
    }
  }

  for (const p of plans) {
    const c = p.clip;
    const label = `${c.song.title} — ${c.song.artist} @${c.start}s`;
    if (p.kind === 'case') {
      console.log(`[改名] ${label}`);
      console.log(`    磁盘: ${p.from}`);
      console.log(`    改为: ${p.to}`);
    } else if (p.kind === 'recut') {
      console.log(`[重切] ${label}`);
      console.log(`    源  : ${c.song.filePath}`);
      console.log(`    生成: ${c.filePath}   (${c.start}s 起, ${c.length}s 长)`);
    } else {
      console.log(`[跳过] ${label}`);
      console.log(`    ${p.why}`);
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('预演结束，什么都没改。确认后加 --apply 执行。');
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  for (const p of plans) {
    if (p.kind === 'blocked') continue;
    const c = p.clip;
    const label = `${c.song.title} @${c.start}s`;
    try {
      if (p.kind === 'case') {
        // Rename rather than copy: the two names are the same file, and leaving
        // the old one would be an orphan that cleanup would later delete.
        fs.renameSync(path.join(CLIPS, p.from), path.join(CLIPS, p.to));
        const lrcFrom = path.join(CLIPS, p.from.replace(/\.mp3$/i, '.lrc'));
        if (fs.existsSync(lrcFrom)) {
          fs.renameSync(lrcFrom, path.join(CLIPS, p.to.replace(/\.mp3$/i, '.lrc')));
        }
      } else {
        clipAudio({
          sourcePath: p.srcPath,
          outputPath: path.join(CLIPS, c.filePath),
          start: c.start,
          length: c.length,
          lyrics: c.lyrics,
        });
      }

      // Confirm by exact name, the way the server will look for it.
      if (!listing(CLIPS).includes(c.filePath)) {
        throw new Error('修复后仍找不到: ' + c.filePath);
      }
      const size = fs.statSync(path.join(CLIPS, c.filePath)).size;
      if (!size) throw new Error('生成的文件是空的: ' + c.filePath);

      done++;
      console.log(`✓ ${label}  (${(size / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`✗ ${label}: ${err.message}`);
    }
  }

  console.log(`\n修复 ${done} 个。数据库一个字都没改。`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('出错:', err);
  await prisma.$disconnect();
  process.exit(1);
});
