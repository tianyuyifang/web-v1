/**
 * 给 last_stream_at 一个起点, 只跑一次。
 *
 * 这一列从现在起由 /api/stream 自己写, 但已经在用的人要等到下次听歌才有值 ——
 * 中间这段时间, 121 位只听歌不做别的用户会显示成「从没用过」。
 *
 * 唯一能追溯的是 bandwidth_logs, 而它只精确到天, 所以填的是那天的正午 ——
 * 日期只说明「这一天听过」, 取中点误差最多半天, 两头都不偏。不取当天结束: 对
 * 今天的记录那等于钳到此刻, 会把上午听过的人说成刚刚还在听, 而「说新了」比
 * 「说旧了」更误事。
 *
 * 也只填那些一条精确记录都没有的人。有精确记录的人时刻本来就准, 拿一个天级的
 * 猜测去盖只会让他们显得比实际活跃。
 *
 * 这里排除的九张表必须和 adminService 里算 lastActiveAt 的那九个来源一致 ——
 * 少查一张, 只在那张表里活动过的人就会被天级猜测盖掉。最初漏了四张, 实测正好
 * 有两位用户中招。
 *
 * 只填空着的行 —— 已经有真实写入的绝不覆盖, 所以重跑安全, 而且跑得越晚影响
 * 越小(真实数据会自己长出来)。
 *
 * 用法:  node scripts/backfill-last-stream.js          预演
 *        node scripts/backfill-last-stream.js --apply
 */
require('dotenv').config();
const prisma = require('../src/db/client');

const APPLY = process.argv.includes('--apply');

(async () => {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT u.id, u.username,
           LEAST(b.d::timestamptz + INTERVAL '12 hours', NOW()) AS t
    FROM users u
    JOIN (SELECT user_id, MAX(date) d FROM bandwidth_logs GROUP BY user_id) b ON b.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(last_seen_at) t FROM capture_sessions GROUP BY user_id) cs ON cs.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(updated_at) t FROM playlists GROUP BY user_id) pl ON pl.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(created_at) t FROM likes GROUP BY user_id) lk ON lk.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(created_at) t FROM clips GROUP BY user_id) cl ON cl.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(updated_at) t FROM song_prefs GROUP BY user_id) sp ON sp.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(created_at) t FROM tag_events GROUP BY user_id) te ON te.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(created_at) t FROM feedback GROUP BY user_id) fb ON fb.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(created_at) t FROM playlist_shares GROUP BY user_id) ps ON ps.user_id = u.id
    LEFT JOIN (SELECT user_id, MAX(created_at) t FROM playlist_copy_permissions GROUP BY user_id) pcp ON pcp.user_id = u.id
    WHERE u.last_stream_at IS NULL
      AND GREATEST(cs.t, pl.t, lk.t, cl.t, sp.t, te.t, fb.t, ps.t, pcp.t) IS NULL
    ORDER BY b.d DESC
  `);

  console.log('可回填(有流量记录且 last_stream_at 为空): ' + rows.length + ' 人');
  if (!rows.length) { await prisma.$disconnect(); return; }

  console.log('\n最近的几位:');
  for (const r of rows.slice(0, 5)) {
    console.log('  ' + String(r.username).padEnd(18) + new Date(r.t).toISOString());
  }

  if (!APPLY) {
    console.log('\n预演 —— 加 --apply 才写。');
    await prisma.$disconnect();
    return;
  }

  // 一条 UPDATE 搞定, 条件里再查一次 IS NULL: 预演到执行之间可能有人听过歌,
  // 那份真实时刻比这里推算的准, 不该被盖掉。
  const n = await prisma.$executeRawUnsafe(`
    UPDATE users u
    SET last_stream_at = LEAST(b.d::timestamptz + INTERVAL '12 hours', NOW())
    FROM (SELECT user_id, MAX(date) d FROM bandwidth_logs GROUP BY user_id) b
    WHERE b.user_id = u.id
      AND u.last_stream_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM capture_sessions x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM playlists x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM likes x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM clips x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM song_prefs x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM tag_events x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM feedback x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM playlist_shares x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM playlist_copy_permissions x WHERE x.user_id = u.id)
  `);
  console.log('\n写入 ' + n + ' 行。');

  const left = await prisma.user.count({ where: { lastStreamAt: null } });
  console.log('仍为空的用户: ' + left + ' 人 (从没听过歌, 或另有精确记录)');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('出错: ' + e.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
