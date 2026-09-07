/**
 * 「他说抓不到歌」的第一手依据。
 *
 * 心跳只证明客户端活着。2026-09-07 有九个用户连着两三天心跳正常、一首歌都没
 * 有（游戏给歌名打了 accessibilityDataSensitive，Android 14+ 就把那个节点对
 * 我们藏了），而服务端当时看到的一切都正常，全靠用户来说才发现。
 *
 * 客户端现在在心跳上捎带两个数：连续扫空多少次、上次真读到是多少秒前。只存
 * 不显示 —— 阈值多少算「不正常」还没有真实分布可依，宁可自己查，也不要给用户
 * 一个会误报的警告。
 *
 *   node scripts/capture-health.js            最近 24 小时还在连的
 *   node scripts/capture-health.js 用户名       只看这个人
 *   node scripts/capture-health.js --hours 72  放宽时间窗
 */
const prisma = require('../src/db/client');

const args = process.argv.slice(2);
const hoursAt = args.indexOf('--hours');
const hours = hoursAt >= 0 ? Number(args[hoursAt + 1]) || 24 : 24;
const username = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--hours');

function verdict(r) {
  // 旧客户端根本不报，别把「没数据」说成「没问题」。
  if (r.blind === null) return '客户端旧，不报此项';
  if (r.events > 0 && r.blind < 20) return '正常';
  if (r.events === 0 && r.blind >= 60) return '可疑：一直扫空且零事件';
  if (r.blind >= 60) return '可疑：当前连续扫空';
  if (r.events === 0) return '还没抓到过，但也没在扫空（可能没进游戏）';
  return '正常';
}

(async () => {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT u.username,
           cs.id,
           cs.client_version                                        AS ver,
           cs.mode,
           cs.target,
           cs.blind_scans                                           AS blind,
           cs.last_read_ago                                         AS read_ago,
           EXTRACT(EPOCH FROM (NOW() - cs.last_seen_at))::int        AS hb,
           (SELECT COUNT(*)::int FROM capture_events e
             WHERE e.session_id = cs.id)                            AS events
      FROM capture_sessions cs
      JOIN users u ON u.id = cs.user_id
     WHERE cs.last_seen_at > NOW() - ($1 || ' hours')::interval
       AND ($2::text IS NULL OR u.username = $2)
     ORDER BY cs.last_seen_at DESC
     LIMIT 40`, String(hours), username || null);

  if (!rows.length) {
    console.log(username
      ? `${username} 最近 ${hours} 小时没有连过`
      : `最近 ${hours} 小时没有会话`);
    await prisma.$disconnect();
    return;
  }

  console.log(`最近 ${hours} 小时${username ? ` · ${username}` : ''}\n`);
  console.log('用户'.padEnd(14) + 'ver  心跳前  扫空  上次读到  事件   判断');
  for (const r of rows) {
    console.log(
      String(r.username).slice(0, 12).padEnd(14)
      + String(r.ver ?? '-').padEnd(5)
      + String(r.hb + 's').padStart(6)
      + String(r.blind ?? '-').padStart(6)
      + String(r.read_ago == null ? '-' : r.read_ago < 0 ? '从未' : r.read_ago + 's').padStart(10)
      + String(r.events).padStart(6)
      + '   ' + verdict(r),
    );
  }

  // 阈值要靠这个定，不是靠猜。等它攒够了，才谈要不要把警告显示给用户。
  const reporting = rows.filter((r) => r.blind !== null);
  if (reporting.length) {
    const withSongs = reporting.filter((r) => r.events > 0).map((r) => r.blind).sort((a, b) => a - b);
    console.log(`\n上报此项的会话 ${reporting.length} 个`);
    if (withSongs.length) {
      console.log('  抓到过歌的，扫空次数分布: '
        + `最小 ${withSongs[0]} · 中位 ${withSongs[Math.floor(withSongs.length / 2)]} `
        + `· 最大 ${withSongs[withSongs.length - 1]}`);
      console.log('  （这些都是能正常工作的，阈值必须高于它们的最大值）');
    }
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
