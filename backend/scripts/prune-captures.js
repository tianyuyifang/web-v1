/**
 * Drop capture rows older than the retention window.
 *
 * capture_events has never had a cleanup, and it is the one table that grows
 * purely with use: measured at 1202 rows a day, which is 440k rows and ~310MB
 * after a year and keeps going. Disk is not really the problem at that size --
 * the problem is that 未配置 recomputes itself from a full scan of every live
 * row ever captured, so the admin page gets slower on data nobody reads.
 *
 * A capture is a receipt, not a record. Once a 歌P capture has been approved the
 * like lives in its own row and the capture says nothing the likes table does
 * not; once a 唱卡 round is over its card is not looked at again. Thirty days
 * is far past either.
 *
 * Two things are deliberately protected:
 *
 *   pending rows -- a 歌P capture waiting for a human decision is work not yet
 *   done, and deleting it silently discards that decision. They are kept
 *   whatever their age and reported, so an old backlog becomes visible rather
 *   than disappearing.
 *
 *   the 未配置 queue -- it is computed from live captures, so pruning shortens
 *   it. That is intended: a song the game has not shown in a month is not
 *   urgent, and it comes straight back the next time it appears. The count is
 *   printed before and after so the shortening is never a surprise.
 *
 *   node scripts/prune-captures.js              # dry run, says what it would do
 *   node scripts/prune-captures.js --apply
 *   node scripts/prune-captures.js --days 60 --apply
 */
require('dotenv').config();

const prisma = require('../src/db/client');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const daysArg = args.indexOf('--days');
const DAYS = daysArg >= 0 ? Math.max(Number(args[daysArg + 1]) || 30, 7) : 30;

/**
 * Deleted in batches rather than in one statement.
 *
 * A single DELETE over hundreds of thousands of rows holds one long
 * transaction and blocks the ingest route behind it; captures arrive every two
 * seconds while a game is running. Batching keeps each lock short enough that
 * nothing waiting on it times out.
 */
const BATCH = 5000;

async function main() {
  const cutoff = new Date(Date.now() - DAYS * 86400000);

  const before = await prisma.captureEvent.count();
  const stale = await prisma.captureEvent.count({
    where: { createdAt: { lt: cutoff }, outcome: { not: 'pending' } },
  });
  const staleButPending = await prisma.captureEvent.count({
    where: { createdAt: { lt: cutoff }, outcome: 'pending' },
  });
  const queueBefore = await prisma.$queryRawUnsafe(
    'SELECT count(DISTINCT raw_text)::int AS n FROM capture_events WHERE playlist_id IS NULL'
  );

  console.log(`保留 ${DAYS} 天（${cutoff.toISOString().slice(0, 10)} 之前的删除）`);
  console.log(`  现有记录       ${before}`);
  console.log(`  可删除         ${stale}`);
  console.log(`  超期但待处理   ${staleButPending}  ← 保留，等人工决定`);
  console.log(`  未配置队列     ${queueBefore[0].n} 首`);

  // Tagging history, before the early returns below: those exit when there are
  // no stale captures, and this table fills and empties on its own schedule.
  // Putting it after them meant a night with nothing to prune here also
  // skipped it entirely -- caught by planting a 40-day-old row and watching it
  // survive.
  //
  // No exception for anything, unlike a pending capture: a tag is a completed
  // act with no decision waiting on it.
  const tagStale = await prisma.tagEvent.count({ where: { createdAt: { lt: cutoff } } });
  if (!tagStale) {
    console.log(`\n打标记录：无需清理（共 ${await prisma.tagEvent.count()} 条）。`);
  } else if (!APPLY) {
    console.log(`\n打标记录：将删除 ${tagStale} 条。`);
  } else {
    const r = await prisma.tagEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    console.log(`\n打标记录：删除 ${r.count} 条，剩余 ${await prisma.tagEvent.count()} 条。`);
  }

  /**
   * Sessions, on a longer clock than everything else here.
   *
   * capture_events cascades from this table, so deleting a session takes its
   * captures with it. Pruning sessions on the same 30-day line would therefore
   * delete captures the 30-day rule had just decided to keep -- the cutoff has
   * to sit strictly after it, and 45 days leaves a fortnight of margin.
   *
   * Worth doing at all because nothing has ever cleaned this table: measured at
   * 39.4 rows a day, with 385 of 827 rows holding no captures whatsoever --
   * pairings that were never used. It is small today (504kB) and this keeps it
   * that way rather than fixing a problem.
   */
  const SESSION_KEEP_DAYS = Math.max(DAYS + 15, 45);
  const sessionCutoff = new Date(Date.now() - SESSION_KEEP_DAYS * 86400000);
  const sessStale = await prisma.captureSession.count({
    where: { createdAt: { lt: sessionCutoff } },
  });
  if (!sessStale) {
    console.log(`
会话记录：无需清理（共 ${await prisma.captureSession.count()} 条，保留 ${SESSION_KEEP_DAYS} 天）。`);
  } else if (!APPLY) {
    console.log(`
会话记录：将删除 ${sessStale} 条（${SESSION_KEEP_DAYS} 天前）。`);
  } else {
    const r = await prisma.captureSession.deleteMany({
      where: { createdAt: { lt: sessionCutoff } },
    });
    console.log(`
会话记录：删除 ${r.count} 条，剩余 ${await prisma.captureSession.count()} 条。`);
  }

  if (!stale) {
    console.log('\n没有要删除的（捕获记录）。');
    return;
  }
  if (!APPLY) {
    console.log('\n这是预演。加 --apply 才会真正删除。');
    return;
  }

  let removed = 0;
  for (;;) {
    // Selected by id first: deleteMany cannot take a limit, and an unbounded
    // one is the long transaction this is trying to avoid.
    const batch = await prisma.captureEvent.findMany({
      where: { createdAt: { lt: cutoff }, outcome: { not: 'pending' } },
      select: { id: true },
      take: BATCH,
    });
    if (!batch.length) break;
    const res = await prisma.captureEvent.deleteMany({
      where: { id: { in: batch.map((b) => b.id) } },
    });
    removed += res.count;
    process.stdout.write(`\r  已删除 ${removed}/${stale}`);
  }

  const queueAfter = await prisma.$queryRawUnsafe(
    'SELECT count(DISTINCT raw_text)::int AS n FROM capture_events WHERE playlist_id IS NULL'
  );
  console.log(`\n\n删除 ${removed} 条，剩余 ${await prisma.captureEvent.count()} 条。`);
  console.log(`未配置队列 ${queueBefore[0].n} → ${queueAfter[0].n} 首`
    + `${queueBefore[0].n === queueAfter[0].n ? '（未变）' : ''}`);

}

main()
  .catch((err) => { console.error('\n', err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
