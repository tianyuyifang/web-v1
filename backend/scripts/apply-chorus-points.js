/**
 * 把本地拉到的副歌点写进库(在 VM 上跑, 但一次外呼都不发)。
 *
 * 读 chorus-results.json —— 那是在自己电脑上问平台问出来的, 这一步纯粹是
 * 搬数据: 逐行 UPDATE, 不联网。
 *
 * 幂等: 反复跑结果一样。没问到的(ms 为 null)也照样打 chorus_fetched_at,
 * 因为「问过, 平台说没有」和「还没问」必须分得开 —— 否则纯器乐每轮都被
 * 重新问一遍, 正是歌词当年踩过的坑。
 *
 * 用法:  node apply-chorus.js            预演, 只统计
 *        node apply-chorus.js --apply    真写
 */
const fs = require('fs');
const prisma = require('../src/db/client');

const APPLY = process.argv.includes('--apply');
const FILE = process.argv.find((a) => a.endsWith('.json')) || '/tmp/chorus-results.json';

(async () => {
  const results = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const keys = Object.keys(results);
  const withPoint = keys.filter((k) => results[k].ms);
  console.log('结果文件: ' + keys.length + ' 首, 其中有副歌点 ' + withPoint.length + ' 首');

  if (!APPLY) {
    console.log('预演 —— 加 --apply 才写库。');
    for (const k of withPoint.slice(0, 5)) {
      console.log('  ' + k + ' -> ' + (results[k].ms / 1000).toFixed(2) + 's');
    }
    await prisma.$disconnect();
    return;
  }

  let written = 0;
  let missing = 0;
  const now = new Date();

  // 一首一句 UPDATE。7000 行在同一台机器上是秒级的事, 换来的是「哪一行没对上」
  // 当场看得见 —— 批量 upsert 会把 externalId 对不上的静默吞掉。
  for (const key of keys) {
    const idx = key.indexOf(':');
    const source = key.slice(0, idx);
    const externalId = key.slice(idx + 1);
    const ms = results[key].ms || null;
    const r = await prisma.importedTrack.updateMany({
      where: { source, externalId },
      data: { chorusMs: ms, chorusFetchedAt: now },
    });
    if (r.count) written += r.count; else missing += 1;
  }

  console.log('写入 ' + written + ' 行, 库里找不到对应行的 ' + missing + ' 首');
  const total = await prisma.importedTrack.count({ where: { chorusMs: { not: null } } });
  console.log('全库现有副歌点: ' + total + ' 首');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('出错: ' + e.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
