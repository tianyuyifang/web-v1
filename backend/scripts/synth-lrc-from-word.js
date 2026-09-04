/**
 * 用逐字歌词合成带时间戳的整句歌词, 写回 imported_tracks.lyric。
 *
 * 治的病: 个别歌 QQ 只给纯文本整句(无时间戳), 页面只能当静态歌词摆着,
 * 不跟唱; 而逐字歌词却带完整毫秒时间。逐字本身就是一行一行的, 每行有
 * 文字有开始时间 —— [mm:ss.xx]行文字 就是现成的整句 LRC。
 *
 * 只对「整句无任何时间戳 且 逐字存在」的行动手; 已同步的歌碰都不碰。
 * 写之前把原文备份进 backups/, 逐字源数据永远在库里, 可随时重新生成。
 *
 * ⚠ 段落校对答案(lyric_passage_matches)按整句行号存, 覆盖歌词会挪行号。
 *   脚本对有答案的歌拒绝动手 —— 2026-09-04 实测全部中招歌答案为零,
 *   这层是给未来兜底的。
 *
 * 用法:  node scripts/synth-lrc-from-word.js <mid> [mid...]        预演
 *        node scripts/synth-lrc-from-word.js <mid> [mid...] --apply
 *        node scripts/synth-lrc-from-word.js --all [--apply]       全部中招的
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const mids = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const hasStamp = (lyric) => String(lyric).split('\n')
  .some((l) => /^\[\d{1,2}:\d{2}/.test(l.trim()));

const stamp = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const c = Math.floor((ms % 1000) / 10);
  const p = (n, w) => String(n).padStart(w, '0');
  return `[${p(m, 2)}:${p(s, 2)}.${p(c, 2)}]`;
};

(async () => {
  let tracks;
  if (ALL) {
    // 只扫「问过平台」的行(lyricFetchedAt 已置)。没问过的不碰: 首播时
    // 平台的回答会覆盖这里合成的, 而且那 800+ 首缺词只是还没人播过,
    // 不是病。问过的行里, 整句为空(平台说没有)和整句无时间戳(纯文本)
    // 都算中招 —— 咕叽咕叽就是前者, 只按「lyric 非空」筛会漏掉它。
    tracks = (await prisma.importedTrack.findMany({
      where: { lyricFetchedAt: { not: null }, wordLyric: { not: null } },
    })).filter((t) => !t.lyric || !hasStamp(t.lyric));
  } else {
    if (!mids.length) { console.log('给 mid 或 --all'); process.exit(1); }
    tracks = await prisma.importedTrack.findMany({
      where: { source: 'QQ', externalId: { in: mids } },
    });
  }

  const backup = [];
  let done = 0;
  for (const t of tracks) {
    const name = `${t.title} — ${t.artist} (${t.externalId})`;
    if (!t.wordLyric) { console.log(`跳过 ${name}: 没有逐字`); continue; }
    if (t.lyric && hasStamp(t.lyric)) { console.log(`跳过 ${name}: 整句已有时间戳`); continue; }

    const answers = await prisma.lyricPassageMatch.count({
      where: { source: t.source, externalId: t.externalId } });
    if (answers > 0) {
      console.log(`拒绝 ${name}: 有 ${answers} 条段落答案, 覆盖会挪行号 — 人工处理`);
      continue;
    }

    let wl = t.wordLyric;
    if (typeof wl === 'string') { try { wl = JSON.parse(wl); } catch (e) { wl = null; } }
    if (!Array.isArray(wl) || wl.length < 4) { console.log(`跳过 ${name}: 逐字不可用`); continue; }

    const lines = [...wl].sort((a, b) => a.start - b.start)
      .filter((x) => x && Number.isFinite(x.start) && String(x.text || '').trim())
      .map((x) => stamp(x.start) + String(x.text).trim());
    if (lines.length < 4) { console.log(`跳过 ${name}: 合成后行数过少`); continue; }
    const synth = lines.join('\n');

    console.log(`${APPLY ? '写入' : '预演'} ${name}: ${lines.length} 行`);
    console.log('  首行 ' + lines[0].slice(0, 44));
    console.log('  末行 ' + lines[lines.length - 1].slice(0, 44));
    if (APPLY) {
      backup.push({ source: t.source, externalId: t.externalId, title: t.title,
        artist: t.artist, oldLyric: t.lyric });
      await prisma.importedTrack.update({
        where: { id: t.id }, data: { lyric: synth } });
      done += 1;
    }
  }

  // 表明出来: 问过平台、有病、但逐字也没有 —— 没法合成的, 别默默略过。
  if (ALL) {
    // 病 = 存着纯文本(不论 fetchedAt, 历史导入有直接写词没打标的旧行),
    // 或问过且平台说没有。没问过又没词的不算 —— 那是还没播过, 不是病。
    // wordLyric 用 JS 过滤: Prisma 的 where wordLyric:null 只匹配 DbNull,
    // 历史行存的 JSON null 会漏网(实测漏掉 4 首纯文本老行)。
    const sick = (await prisma.importedTrack.findMany({
      where: { source: { in: ['QQ', 'NETEASE'] } },
      select: { source: true, externalId: true, title: true, artist: true,
        lyric: true, lyricFetchedAt: true, wordLyric: true },
    })).filter((t) => !t.wordLyric
      && ((t.lyric && !hasStamp(t.lyric)) || (!t.lyric && t.lyricFetchedAt)));
    if (sick.length) {
      console.log('');
      console.log('== 没法修(逐字也无, 平台两样都没给) ' + sick.length + ' 首 ==');
      sick.forEach((t) => console.log('  ' + t.source.padEnd(9) + t.externalId.padEnd(16)
        + t.title + ' — ' + t.artist
        + (t.lyric ? '  (有纯文本, 静态显示)' : '  (完全无词)')));
    } else {
      console.log('');
      console.log('没法修的: 0 首');
    }
  }

  if (APPLY && backup.length) {
    const file = path.join(__dirname, '..', 'backups',
      `synth-lrc-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\n写入 ${done} 首; 原文备份 -> ${file}`);
  } else if (!APPLY) {
    console.log('\n预演 — 加 --apply 才写。');
  }
  await prisma.$disconnect();
})();
