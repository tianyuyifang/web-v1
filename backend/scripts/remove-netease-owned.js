/**
 * Remove the tracks that turned out to be NetEase songs, so they can be
 * imported again from the right place.
 *
 * The audit found 180 catalogue rows filed under QQ whose mids QQ will not
 * resolve at any tier, and which play on NetEase. The obvious repair is to
 * rewrite each row's source and id -- but those NetEase ids came from a title
 * search, and a search is a guess: 陆虎-拉过勾的 matched a remix by a different
 * singer, 海屿你 matched only the lead of a duo. Correcting 180 rows that way
 * means checking 180 guesses by hand.
 *
 * Importing a NetEase playlist instead makes the question disappear. The ids
 * come from NetEase itself, so nothing needs matching, and the titles and
 * artists arrive from the platform that actually holds the song rather than
 * copied from the one that does not.
 *
 * So they are deleted rather than rewritten. Nineteen carry a mapping and
 * twelve of those were confirmed by hand; those go too, and will need
 * confirming once more after the re-import. Worth it: as they stand they point
 * at a QQ id that cannot play, so a song that reads "confirmed" fails the
 * moment anyone presses it.
 *
 * Capture history stays. It records what the game showed, which is still true.
 *
 * The backup keeps each row's NetEase id alongside it, so a song the new
 * playlist happens to miss can still be traced.
 *
 *   node scripts/remove-netease-owned.js
 *   node scripts/remove-netease-owned.js --apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');
const songPrefs = require('../src/services/songPrefService');

const APPLY = process.argv.includes('--apply');
const IN = path.join(__dirname, '../backups/netease-lookup.json');

(async () => {
  const lookup = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const playable = lookup.results.filter(
    (r) => r.netease && r.netease.playable === true
  );
  const ids = playable.map((r) => r.externalId);
  if (!ids.length) { console.log('nothing to remove'); return; }

  const tracks = await prisma.importedTrack.findMany({
    where: { source: 'QQ', externalId: { in: ids } },
  });
  const maps = await prisma.songMapping.findMany({
    where: { source: 'QQ', externalId: { in: ids } },
  });

  console.log(`playable on NetEase, not on QQ: ${playable.length}`);
  console.log(`  catalogue rows to remove:     ${tracks.length}`);
  console.log(`  mappings to remove:           ${maps.length}`);
  console.log(`    confirmed by hand:          ${maps.filter((m) => m.approved).length}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = path.join(__dirname, `../backups/removed-netease-owned-${stamp}.json`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to remove them.');
    console.log(`A backup would be written to ${dump}`);
    return;
  }

  // The NetEase id sits beside each row: the point of removing these is to
  // import them from NetEase, and a song the new playlist misses is easier to
  // chase with its id already found.
  const byMid = new Map(playable.map((r) => [r.externalId, r.netease]));
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify({
    removedAt: new Date().toISOString(),
    reason: 'NetEase tracks filed under QQ; to be re-imported from a NetEase playlist',
    tracks: tracks.map((t) => ({ ...t, neteaseFound: byMid.get(t.externalId) || null })),
    mappings: maps,
  }, null, 2), 'utf8');
  console.log(`\nbacked up ${tracks.length} tracks and ${maps.length} mappings to`);
  console.log(`  ${dump}`);

  // Mappings first, so no mapping is ever left pointing at a row that is gone.
  const delMaps = maps.length
    ? await prisma.songMapping.deleteMany({ where: { id: { in: maps.map((m) => m.id) } } })
    : { count: 0 };
  const delTracks = await prisma.importedTrack.deleteMany({
    where: { id: { in: tracks.map((t) => t.id) } },
  });

  // Singers' saved keys for these recordings go too: with the track out of the
  // catalogue there is nothing left to sing, so the key describes nothing. No
  // foreign key can do this -- source+externalId spans three unrelated id
  // spaces -- so every deletion path has to say so explicitly.
  const delPrefs = await songPrefs.forgetTracks(tracks);

  console.log(`\nremoved ${delMaps.count} mappings and ${delTracks.count} catalogue rows`);
  console.log(`removed ${delPrefs.count} saved singer preferences`);
  console.log(`catalogue now holds ${await prisma.importedTrack.count()} tracks`);
})()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
