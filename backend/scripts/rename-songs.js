/**
 * Rename songs in bulk, keeping the database and the audio files in step.
 *
 * A title is not just a label: it is baked into the mp3 filename of the song
 * and of every clip cut from it (clipService.buildClipFilename). Changing
 * `songs.title` alone leaves every clip pointing at a file that no longer
 * exists, and the playlist entry then plays silence — the failure is invisible
 * until someone presses play.
 *
 * What a rename touches:
 *   songs   title, file_path, and the five title_pinyin_* columns (search reads
 *           those, so a title updated without them is findable only by its old
 *           name)
 *   clips   file_path, for every clip of that song
 *   disk    the song mp3, every clip mp3, and each clip's .lrc
 *
 * What it deliberately does not touch: clip ids, playlist_clips, likes. Every
 * relationship is on a uuid, so 106 playlists can hold a song through a rename
 * without noticing. That is why this only ever UPDATEs — no row is deleted or
 * recreated, and nothing a user built can be lost by renaming.
 *
 * Usage:
 *   node scripts/rename-songs.js --xlsx list.xlsx              # dry run
 *   node scripts/rename-songs.js --xlsx list.xlsx --apply      # do it
 *
 * The sheet needs three columns: Title, Artist, NewTitle.
 * Artist is required because eight titles in this library are shared by five
 * or six different songs; matching on title alone would rename all of them.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const prisma = require('../src/db/client');
const {
  toPinyin, toPinyinInitials, toPinyinConcat, toPinyinAll, toPinyinInitialsAll,
} = require('../src/utils/pinyin');

const MP3_BASE = process.env.MP3_BASE_PATH || '/var/www/music/allSongs';
const CLIPS_BASE = process.env.CLIPS_BASE_PATH || '/var/www/music/allClips';

const argv = process.argv;
const APPLY = argv.includes('--apply');
const xlsxArg = argv.indexOf('--xlsx');
const XLSX_PATH = xlsxArg !== -1 ? argv[xlsxArg + 1] : null;
const BACKUP_DIR = path.join(__dirname, '..', 'rename-backups');

/** Characters Windows rejects in a filename. Mirrors clipService exactly. */
const safe = (s) => String(s).replace(/[<>:"/\\|?*]/g, '_');

/** The clip filename for a song at a given start. Must match clipService. */
function buildClipFilename(title, artist, start) {
  const artists = artist.split('_').map((a) => a.trim()).join(' & ');
  return `${safe(title)} - ${safe(artists)} - ${start}.mp3`;
}

/**
 * The song's own mp3 filename.
 *
 * Derived from the existing path rather than rebuilt, so that a file whose name
 * never followed the "title - artist.mp3" convention keeps its own shape. Only
 * the title portion is replaced.
 */
function buildSongFilename(oldPath, oldTitle, newTitle) {
  const dir = path.dirname(oldPath);
  const base = path.basename(oldPath);
  const oldSafe = safe(oldTitle);
  if (!base.startsWith(oldSafe)) return null;   // unrecognised shape; caller reports it
  const renamed = safe(newTitle) + base.slice(oldSafe.length);
  return dir === '.' ? renamed : path.join(dir, renamed);
}

/**
 * Does this exact filename exist, matching case?
 *
 * fs.existsSync() is case-insensitive on Windows and case-sensitive on Linux,
 * so a name that differs only in case passes locally and 404s in production —
 * which is exactly how three clips in this library ended up unplayable
 * ("One world one dream" on disk against "One World One Dream" in the row).
 * Comparing against the directory listing gives the same answer on both.
 */
const listingCache = new Map();
function existsExact(dir, name) {
  if (!listingCache.has(dir)) {
    listingCache.set(dir, fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : new Set());
  }
  return listingCache.get(dir).has(name);
}
function forgetListing(dir) { listingCache.delete(dir); }

/** Copy, leaving the original in place. The source must survive until the end. */
function copyFile(from, to) {
  fs.copyFileSync(from, to);
  if (!fs.existsSync(to)) throw new Error('copy produced nothing: ' + to);
  if (fs.statSync(to).size !== fs.statSync(from).size) {
    throw new Error('copy is a different size: ' + to);
  }
}

/**
 * Work out everything one rename entails, without doing any of it.
 *
 * Returns a plan, or a reason the row cannot be processed. Every check that can
 * fail is done here, so --apply starts only from rows already known to be sound.
 */
async function planRename(row, seenNewNames) {
  const title = String(row.Title == null ? '' : row.Title).trim();
  const artist = String(row.Artist == null ? '' : row.Artist).trim();
  const newTitle = String(row.NewTitle == null ? '' : row.NewTitle).trim();

  if (!title || !newTitle) return { skip: 'Title 或 NewTitle 为空' };
  if (!artist) return { skip: 'Artist 为空 —— 曲库里有同名歌，必须指定歌手' };
  if (title === newTitle) return { skip: '新旧标题相同' };

  const matches = await prisma.song.findMany({
    where: { title, artist },
    include: { clips: { orderBy: { start: 'asc' } } },
  });
  if (!matches.length) return { skip: `曲库里没有「${title} — ${artist}」` };
  if (matches.length > 1) {
    return { skip: `匹配到 ${matches.length} 首同名同歌手的歌，无法唯一定位（需要用 songId）` };
  }

  const song = matches[0];
  const newSongPath = buildSongFilename(song.filePath, title, newTitle);
  if (!newSongPath) {
    return { skip: `文件名 "${song.filePath}" 不是以标题开头，无法安全推导新名` };
  }

  // The source files must all be present before anything is touched. A clip
  // whose file is already missing is reported rather than silently carried
  // forward — three such clips exist today and they play silence.
  const problems = [];
  if (!existsExact(MP3_BASE, song.filePath)) {
    problems.push(`源 mp3 不存在: ${song.filePath}`);
  }
  if (existsExact(MP3_BASE, newSongPath)) {
    problems.push(`目标 mp3 已存在，会覆盖: ${newSongPath}`);
  }

  const clipMoves = [];
  for (const c of song.clips) {
    if (!c.filePath) continue;   // a clip with no file has nothing to move
    const to = buildClipFilename(newTitle, song.artist, c.start);
    if (!existsExact(CLIPS_BASE, c.filePath)) {
      problems.push(`clip 文件缺失: ${c.filePath}`);
      continue;
    }
    if (existsExact(CLIPS_BASE, to)) {
      problems.push(`目标 clip 已存在，会覆盖: ${to}`);
      continue;
    }
    if (seenNewNames.has(to)) {
      problems.push(`本批次内两首歌会写到同一个 clip 文件: ${to}`);
      continue;
    }
    seenNewNames.add(to);
    clipMoves.push({ clipId: c.id, from: c.filePath, to, start: c.start });
  }

  return {
    song,
    newTitle,
    songMove: { from: song.filePath, to: newSongPath },
    clipMoves,
    problems,
    pinyin: {
      titlePinyin: toPinyin(newTitle),
      titlePinyinInitials: toPinyinInitials(newTitle),
      titlePinyinConcat: toPinyinConcat(newTitle),
      titlePinyinAll: toPinyinAll(newTitle),
      titlePinyinInitialsAll: toPinyinInitialsAll(newTitle),
    },
  };
}

/**
 * Carry out one planned rename.
 *
 * Ordered so that every intermediate state is playable:
 *   1 copy the files under their new names — the old ones still exist and the
 *     database still points at them, so playback is unaffected
 *   2 verify each copy is readable under its exact name
 *   3 update the rows in one transaction — song and clips move together
 *   4 verify every stored path resolves on disk
 *   5 only now delete the originals
 *
 * A crash at any point leaves the database pointing at a file that exists.
 * Re-running picks up from wherever it stopped.
 */
async function applyRename(plan) {
  const { song, newTitle, songMove, clipMoves, pinyin } = plan;

  // --- 1. copy ---
  const copied = [];
  const songFrom = path.join(MP3_BASE, songMove.from);
  const songTo = path.join(MP3_BASE, songMove.to);
  if (!existsExact(MP3_BASE, songMove.to)) {
    copyFile(songFrom, songTo);
    copied.push(songTo);
  }
  for (const m of clipMoves) {
    if (existsExact(CLIPS_BASE, m.to)) continue;   // resumed run
    copyFile(path.join(CLIPS_BASE, m.from), path.join(CLIPS_BASE, m.to));
    copied.push(path.join(CLIPS_BASE, m.to));
    // The lyrics file rides along; losing it would silently drop the lyrics.
    const lrcFrom = path.join(CLIPS_BASE, m.from.replace(/\.mp3$/i, '.lrc'));
    if (fs.existsSync(lrcFrom)) {
      copyFile(lrcFrom, path.join(CLIPS_BASE, m.to.replace(/\.mp3$/i, '.lrc')));
    }
  }
  forgetListing(MP3_BASE);
  forgetListing(CLIPS_BASE);

  // --- 2. verify the copies, by exact name ---
  if (!existsExact(MP3_BASE, songMove.to)) throw new Error('新 mp3 校验失败: ' + songMove.to);
  for (const m of clipMoves) {
    if (!existsExact(CLIPS_BASE, m.to)) throw new Error('新 clip 校验失败: ' + m.to);
  }

  // --- 3. update, all or nothing ---
  await prisma.$transaction([
    prisma.song.update({
      where: { id: song.id },
      data: { title: newTitle, filePath: songMove.to, ...pinyin },
    }),
    ...clipMoves.map((m) =>
      prisma.clip.update({ where: { id: m.clipId }, data: { filePath: m.to } })),
  ]);

  // --- 4. verify what the database now claims ---
  const after = await prisma.song.findUnique({
    where: { id: song.id },
    include: { clips: true },
  });
  if (!existsExact(MP3_BASE, after.filePath)) {
    throw new Error('更新后 song.file_path 指向不存在的文件: ' + after.filePath);
  }
  for (const c of after.clips) {
    if (c.filePath && !existsExact(CLIPS_BASE, c.filePath)) {
      throw new Error('更新后 clip.file_path 指向不存在的文件: ' + c.filePath);
    }
  }

  // --- 5. the originals are now unreferenced ---
  try { fs.unlinkSync(songFrom); } catch { /* already gone on a resumed run */ }
  for (const m of clipMoves) {
    try { fs.unlinkSync(path.join(CLIPS_BASE, m.from)); } catch { /* ditto */ }
    try { fs.unlinkSync(path.join(CLIPS_BASE, m.from.replace(/\.mp3$/i, '.lrc'))); } catch { /* ditto */ }
  }
  forgetListing(MP3_BASE);
  forgetListing(CLIPS_BASE);
}

(async () => {
  if (!XLSX_PATH) {
    console.error('用法: node scripts/rename-songs.js --xlsx <文件> [--apply]');
    console.error('表格需要三列: Title, Artist, NewTitle');
    process.exit(1);
  }
  if (!fs.existsSync(XLSX_PATH)) {
    console.error('找不到文件: ' + XLSX_PATH);
    process.exit(1);
  }

  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  console.log(APPLY ? '=== 执行模式 ===' : '=== 预演 (DRY RUN) —— 不会做任何改动 ===');
  console.log(`读取 ${rows.length} 行\n`);

  const plans = [];
  const skipped = [];
  const blocked = [];
  const seenNewNames = new Set();

  for (const row of rows) {
    const plan = await planRename(row, seenNewNames);
    if (plan.skip) { skipped.push({ row, why: plan.skip }); continue; }
    if (plan.problems.length) { blocked.push(plan); continue; }
    plans.push(plan);
  }

  for (const p of plans) {
    console.log(`✓ ${p.song.title} — ${p.song.artist}`);
    console.log(`    改为: ${p.newTitle}`);
    console.log(`    mp3 : ${p.songMove.from}`);
    console.log(`       -> ${p.songMove.to}`);
    console.log(`    clip: ${p.clipMoves.length} 个`);
    for (const m of p.clipMoves.slice(0, 3)) console.log(`       @${m.start}s  ${m.to}`);
    if (p.clipMoves.length > 3) console.log(`       ... 另外 ${p.clipMoves.length - 3} 个`);
    console.log(`    拼音: ${p.pinyin.titlePinyinConcat} / ${p.pinyin.titlePinyinInitials}`);
    console.log('');
  }

  if (blocked.length) {
    console.log('--- 有问题，已跳过（需要先处理）---');
    for (const b of blocked) {
      console.log(`✗ ${b.song.title} — ${b.song.artist}`);
      for (const p of b.problems) console.log(`    ${p}`);
    }
    console.log('');
  }
  if (skipped.length) {
    console.log('--- 无法处理的行 ---');
    for (const s of skipped) {
      console.log(`✗ ${s.row.Title || '(空)'} — ${s.row.Artist || '(空)'}: ${s.why}`);
    }
    console.log('');
  }

  const clipTotal = plans.reduce((n, p) => n + p.clipMoves.length, 0);
  console.log(`可以改: ${plans.length} 首  (涉及 ${clipTotal} 个 clip)`);
  console.log(`有问题: ${blocked.length} 首   无法处理: ${skipped.length} 行`);

  if (!APPLY) {
    console.log('\n预演结束，什么都没改。确认无误后加 --apply 执行。');
    await prisma.$disconnect();
    return;
  }
  if (!plans.length) {
    console.log('\n没有可以执行的项目。');
    await prisma.$disconnect();
    return;
  }

  // Snapshot the rows before touching them. The files survive until the last
  // step, so this plus the originals is enough to put everything back.
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `rename-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    when: new Date().toISOString(),
    songs: plans.map((p) => ({
      id: p.song.id,
      title: p.song.title,
      filePath: p.song.filePath,
      titlePinyin: p.song.titlePinyin,
      titlePinyinInitials: p.song.titlePinyinInitials,
      titlePinyinConcat: p.song.titlePinyinConcat,
      titlePinyinAll: p.song.titlePinyinAll,
      titlePinyinInitialsAll: p.song.titlePinyinInitialsAll,
      clips: p.song.clips.map((c) => ({ id: c.id, filePath: c.filePath })),
    })),
  }, null, 2), 'utf8');
  console.log(`\n已备份原始记录: ${backupPath}\n`);

  let done = 0;
  for (const p of plans) {
    try {
      await applyRename(p);
      done++;
      console.log(`✓ ${p.song.title} -> ${p.newTitle}  (${p.clipMoves.length} 个 clip)`);
    } catch (err) {
      // Stop here. Everything before this succeeded and was verified; this song
      // is mid-flight but its old files are still on disk, so it still plays.
      console.error(`\n✗ 「${p.song.title}」失败: ${err.message}`);
      console.error('已停止。此歌的旧文件仍在，播放不受影响。');
      console.error(`已完成 ${done}/${plans.length} 首。修好后重跑本脚本会跳过已完成的。`);
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  console.log(`\n完成 ${done} 首。备份: ${backupPath}`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('出错:', err);
  await prisma.$disconnect();
  process.exit(1);
});
