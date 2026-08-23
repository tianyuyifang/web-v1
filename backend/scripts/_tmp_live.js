/** Live diagnosis of the most recent capture session. Read-only. */
const prisma = require('../src/db/client');

(async () => {
  const s = await prisma.captureSession.findFirst({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, playlistId: true, createdAt: true, expiresAt: true,
      endedAt: true, lastSeenAt: true, pairCode: true, pairExpiresAt: true,
      _count: { select: { events: true } },
    },
  });
  if (!s) { console.log('no sessions'); await prisma.$disconnect(); return; }

  const now = Date.now();
  console.log('=== 最新 session ===');
  console.log('  创建:        ' + s.createdAt.toISOString());
  console.log('  过期:        ' + s.expiresAt.toISOString() +
    (s.expiresAt < new Date() ? '   ❌ 已过期' : '   ✅ 未过期'));
  console.log('  手动停止:    ' + (s.endedAt ? s.endedAt.toISOString() + '  ❌' : '否 ✅'));
  console.log('  最后收到数据: ' + (s.lastSeenAt ? s.lastSeenAt.toISOString() +
    '  (' + Math.round((now - s.lastSeenAt) / 1000) + ' 秒前)' : '从未 ❌'));
  console.log('  配对码:      ' + (s.pairCode || '(已被领取)'));
  console.log('  事件数:      ' + s._count.events);

  // Was the token ever redeemed? pairCode null means yes.
  console.log('\n=== 判定 ===');
  if (s.endedAt) console.log('  session 已被停止 -> APK 发来的请求会 401，面板显示断开');
  else if (s.expiresAt < new Date()) console.log('  session 已过期 -> 同上');
  else if (!s.lastSeenAt) console.log('  APK 从未连上（配对码没输，或输了但没成功）');
  else {
    const age = Math.round((now - s.lastSeenAt) / 1000);
    console.log('  session 有效。距上次收到数据 ' + age + ' 秒 -> ' +
      (age <= 60 ? 'connected' : 'stale（面板会报断开）'));
  }

  // Any sessions still alive that could be competing?
  const alive = await prisma.captureSession.count({
    where: { endedAt: null, expiresAt: { gt: new Date() } },
  });
  console.log('\n仍然有效的 session 总数: ' + alive +
    (alive > 1 ? '   ⚠ 多个有效 session，APK 可能连到了旧的那个' : ''));

  if (alive > 1) {
    const list = await prisma.captureSession.findMany({
      where: { endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, lastSeenAt: true, playlistId: true,
                _count: { select: { events: true } } },
    });
    for (const x of list) {
      console.log('   ' + x.createdAt.toISOString().slice(5, 19) +
        '  playlist=' + x.playlistId.slice(0, 8) +
        '  事件=' + x._count.events +
        '  lastSeen=' + (x.lastSeenAt ? Math.round((now - x.lastSeenAt) / 1000) + 's前' : '从未'));
    }
  }

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
