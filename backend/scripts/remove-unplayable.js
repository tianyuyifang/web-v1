/**
 * Remove the songs neither platform will play.
 *
 * The audit ended with 38 tracks that resolve nowhere: 20 that both QQ and
 * NetEase decline on rights -- nine of them 华晨宇 digital-album releases --
 * and 18 whose title and artist are so mangled that no search can find them
 * (a whole line of lyrics in the title field, an unclosed 《, a short-video
 * uploader's handle where the artist belongs). Neither kind can be fixed by
 * changing which platform they point at, so they leave the catalogue.
 *
 * Three of them carry a mapping, one of it confirmed by hand. Those go too:
 * a mapping to a track that cannot be played is worse than no mapping, since
 * the song looks available right up until someone presses play. Afterwards
 * they read as 未配置, which is what they are.
 *
 * Capture history is left alone. Those events record what the game showed,
 * which is still true, and deleting them would put a hole in the review page's
 * past. They will show 未配置 once their mapping is gone.
 *
 * Everything removed is written to a file first. The catalogue rows are the
 * only record of which songs these were, and the intent is to find better
 * sources for them later.
 *
 *   node scripts/remove-unplayable.js            # show what would go
 *   node scripts/remove-unplayable.js --apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');

const APPLY = process.argv.includes('--apply');
const IN = path.join(__dirname, '../backups/qq-retry-tiers.json');

(async () => {
  const audit = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const ids = audit.stillDead.map((d) => d.externalId);
  if (!ids.length) { console.log('nothing listed as unplayable'); return; }

  const tracks = await prisma.importedTrack.findMany({
    where: { source: 'QQ', externalId: { in: ids } },
  });
  const maps = await prisma.songMapping.findMany({
    where: { source: 'QQ', externalId: { in: ids } },
  });

  console.log(`unplayable on both platforms: ${ids.length}`);
  console.log(`  catalogue rows to remove:   ${tracks.length}`);
  console.log(`  mappings to remove:         ${maps.length}`);
  for (const m of maps) {
    console.log(`    "${m.platformTitle}" — ${m.platformArtist}`
      + `${m.approved ? '  (confirmed by hand)' : ''}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = path.join(__dirname, `../backups/removed-unplayable-${stamp}.json`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to remove them.');
    console.log(`A backup would be written to ${dump}`);
    return;
  }

  // Written before anything is deleted: these rows are the only record of
  // which songs these were, and the plan is to source them again elsewhere.
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify({
    removedAt: new Date().toISOString(),
    reason: 'unplayable on QQ (all four tiers) and on NetEase',
    tracks,
    mappings: maps,
  }, null, 2), 'utf8');
  console.log(`\nbacked up ${tracks.length} tracks and ${maps.length} mappings to`);
  console.log(`  ${dump}`);

  // Mappings first. A catalogue row deleted while a mapping still points at it
  // would leave the mapping claiming a track that no longer exists.
  const delMaps = maps.length
    ? await prisma.songMapping.deleteMany({ where: { id: { in: maps.map((m) => m.id) } } })
    : { count: 0 };
  const delTracks = await prisma.importedTrack.deleteMany({
    where: { id: { in: tracks.map((t) => t.id) } },
  });

  console.log(`\nremoved ${delMaps.count} mappings and ${delTracks.count} catalogue rows`);

  const left = await prisma.importedTrack.count();
  console.log(`catalogue now holds ${left} tracks`);
})()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
