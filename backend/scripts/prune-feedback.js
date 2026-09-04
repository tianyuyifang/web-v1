/**
 * Drop feedback that was answered a long time ago.
 *
 * A feedback row is a conversation, and the reply is stored on the row, so
 * deleting the row deletes the answer with it. That makes deletion safe only
 * once the sender has had ample time to read it: the site cannot know they
 * did (last-seen lives in each browser), so time stands in for it. Ninety
 * days is a quarter — anyone who has not opened the site in that long has
 * lost nothing they were waiting on, and the nightly backup (03:00, before
 * this runs at 03:30-style scheduling) still holds the row for a week anyway.
 *
 * Unreplied feedback is NEVER touched, whatever its age. An unanswered item
 * is the admin's to-do list, and auto-deleting it is auto-ignoring a user.
 *
 *   node scripts/prune-feedback.js              # dry run, says what it would do
 *   node scripts/prune-feedback.js --apply
 *   node scripts/prune-feedback.js --days 180 --apply
 */
require('dotenv').config();

const prisma = require('../src/db/client');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const daysArg = args.indexOf('--days');
// Floor of 30: a lower number risks deleting answers before slow visitors
// read them, and there is no size pressure pushing the other way — the table
// grows by a handful of rows a month.
const DAYS = daysArg >= 0 ? Math.max(Number(args[daysArg + 1]) || 90, 30) : 90;

async function main() {
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

  const total = await prisma.feedback.count();
  const unreplied = await prisma.feedback.count({ where: { reply: null } });
  const stale = await prisma.feedback.findMany({
    where: { reply: { not: null }, repliedAt: { lt: cutoff } },
    select: { id: true, type: true, title: true, message: true, repliedAt: true },
    orderBy: { repliedAt: 'asc' },
  });

  console.log(`[prune-feedback] ${new Date().toISOString()}`);
  console.log(`  total ${total} | unreplied (kept always) ${unreplied} | replied >${DAYS}d ago: ${stale.length}`);
  for (const f of stale.slice(0, 20)) {
    const what = f.title || (f.message || '').slice(0, 30);
    console.log(`    ${f.repliedAt.toISOString().slice(0, 10)}  ${f.type}  ${what}`);
  }
  if (stale.length > 20) console.log(`    … and ${stale.length - 20} more`);

  if (!APPLY) {
    console.log('  dry run — nothing deleted. Run with --apply to delete.');
    return;
  }
  if (stale.length === 0) {
    console.log('  nothing to delete.');
    return;
  }

  const res = await prisma.feedback.deleteMany({
    where: { id: { in: stale.map((f) => f.id) } },
  });
  console.log(`  deleted ${res.count} rows.`);
}

main()
  .catch((e) => { console.error('[prune-feedback] FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
