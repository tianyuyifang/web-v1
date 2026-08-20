/**
 * Clear out mappings that were made from a title with no artist.
 *
 * These came from 歌 P titles reaching the 唱卡 channel before the client
 * filtered by round: 歌 P names a song "《纯真》" and never names the singer,
 * so the row was keyed on a title alone. Matching that way is not merely
 * incomplete, it is wrong -- 夜夜夜夜 with no artist was paired with 梁静茹
 * when the game had said 齐秦.
 *
 * Two outcomes, decided per row:
 *
 *   update   another mapping already points at the same platform track with a
 *            proper game-side artist, so this one is a duplicate of a row that
 *            is already correct. Dropped.
 *   unseen   nothing else claims that track. The mapping goes, and the pool row
 *            is marked unclaimed again, which is exactly what it is: the song
 *            has not actually turned up in 唱卡 yet, only its 歌 P name did.
 *
 * Dry run by default, like the other maintenance scripts here. Pass --apply to
 * write, and it always dumps what it touched first.
 *
 *   node scripts/clean-artistless-mappings.js
 *   node scripts/clean-artistless-mappings.js --apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');

const APPLY = process.argv.includes('--apply');

(async () => {
  const suspect = await prisma.songMapping.findMany({
    where: { rawArtist: '' },
    select: {
      id: true, rawTitle: true, rawArtist: true, titleKey: true, artistKey: true,
      source: true, externalId: true, platformTitle: true, platformArtist: true,
      approved: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!suspect.length) {
    console.log('Nothing to do: no mapping has an empty game-side artist.');
    return;
  }

  const toDrop = [];
  const toUnseen = [];
  for (const m of suspect) {
    const better = await prisma.songMapping.findFirst({
      where: {
        source: m.source,
        externalId: m.externalId,
        rawArtist: { not: '' },
        NOT: { id: m.id },
      },
      select: { rawTitle: true, rawArtist: true },
    });
    if (better) toDrop.push({ ...m, better });
    else toUnseen.push(m);
  }

  console.log(`artistless mappings: ${suspect.length}`);
  console.log(`  approved among them: ${suspect.filter((m) => m.approved).length}`);
  console.log(`  drop (a correct row already exists): ${toDrop.length}`);
  console.log(`  return to unseen (nothing else claims it): ${toUnseen.length}`);
  console.log('');

  for (const m of toDrop.slice(0, 8)) {
    console.log(`  drop   "${m.rawTitle}"  <- kept "${m.better.rawTitle} / ${m.better.rawArtist}"`);
  }
  for (const m of toUnseen.slice(0, 8)) {
    console.log(`  unseen "${m.rawTitle}"  (${m.source} ${m.platformTitle} / ${m.platformArtist})`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  // Written before anything is deleted: these rows carry the only record of
  // which platform track each game title had been matched to.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = path.join(__dirname, `../backups/artistless-mappings-${stamp}.json`);
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify({ toDrop, toUnseen }, null, 2), 'utf8');
  console.log(`\nSaved ${suspect.length} rows to ${dump}`);

  const ids = suspect.map((m) => m.id);
  const removed = await prisma.songMapping.deleteMany({ where: { id: { in: ids } } });

  // Only for the ones nothing else claims. Clearing it for the others would
  // un-count a track that a correct mapping is still using.
  let released = 0;
  for (const m of toUnseen) {
    const r = await prisma.importedTrack.updateMany({
      where: { source: m.source, externalId: m.externalId },
      data: { matchedAt: null },
    });
    released += r.count;
  }

  console.log(`Deleted ${removed.count} mappings, returned ${released} tracks to unseen.`);
})()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
