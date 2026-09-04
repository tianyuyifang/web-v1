/**
 * 给还没问过平台的池子歌拉一次整句歌词(和首播时走的完全是同一条路)。
 *
 * 整句本是首播才懒加载的, 这对播放没问题, 但让导入流程当场诊断不了
 * 「平台没给歌词/给的是无时间戳纯文本」——病要等有人播过才现形。导入时
 * 就问一遍, 病当场暴露, 接着跑 synth-lrc-from-word.js --all 能修的修、
 * 不能修的列出来。副作用只有好的: 首次打开这些歌不再等平台往返。
 *
 * 走 lyricStore.getOrFetch —— 和首播完全同一条路: 成功才写 lyric +
 * lyricFetchedAt, 失败不打标下次自动重试, 去重防并发。请求不带凭证,
 * 800ms 一首(和逐字回填同款节奏), 几十首新歌就是几十秒。
 *
 * 用法:  node scripts/backfill-line-lyrics.js            预演(近48h新歌)
 *        node scripts/backfill-line-lyrics.js --apply
 *        node scripts/backfill-line-lyrics.js --backlog --apply   全部积压
 */
require('dotenv').config();
const prisma = require('../src/db/client');
const lyricStore = require('../src/services/lyricStore');
const qq = require('../src/services/sources/qqSource');
const netease = require('../src/services/sources/neteaseLogin');

const APPLY = process.argv.includes('--apply');
const BACKLOG = process.argv.includes('--backlog');
const PACE_MS = 800;

(async () => {
  const where = {
    source: { in: ['QQ', 'NETEASE'] },
    lyricFetchedAt: null,
    ...(BACKLOG ? {} : { createdAt: { gte: new Date(Date.now() - 48 * 3600 * 1000) } }),
  };
  const tracks = await prisma.importedTrack.findMany({
    where, select: { source: true, externalId: true, title: true, artist: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log((BACKLOG ? '全部积压' : '近48小时新导') + '且整句没问过的: '
    + tracks.length + ' 首' + (APPLY ? '' : '  (预演, 加 --apply 才拉)'));
  if (!APPLY || !tracks.length) {
    tracks.slice(0, 10).forEach((t) => console.log('  ' + t.title + ' — ' + t.artist));
    if (tracks.length > 10) console.log('  ... 共 ' + tracks.length + ' 首');
    process.exit(0);
  }

  let got = 0; let none = 0; let failed = 0;
  for (const t of tracks) {
    const fetcher = t.source === 'QQ'
      ? () => qq.getLyric(t.externalId)
      : () => netease.getLyric(t.externalId);
    try {
      const r = await lyricStore.getOrFetch(t.source, t.externalId, fetcher);
      if (r.lyric) got += 1; else { none += 1; console.log('  平台说没有: ' + t.title + ' — ' + t.artist); }
    } catch (e) {
      failed += 1;
      console.log('  失败(下次自动重试): ' + t.title + ' — ' + e.message.slice(0, 40));
    }
    await new Promise((s) => setTimeout(s, PACE_MS));
  }
  console.log('\n拉到 ' + got + ' 首, 平台说没有 ' + none + ' 首, 失败 ' + failed + ' 首');
  console.log('接着跑: node scripts/synth-lrc-from-word.js --all   (修无时间戳/无歌词的)');
  await prisma.$disconnect();
})();
