/**
 * Remove the NetEase tracks the platform will not play.
 *
 * They are identified by asking song/detail, not by a stored list: a delisted
 * track is a fact about the platform today, and re-deriving it means this can
 * be run again after a later import without editing anything.
 *
 * Everything removed is written to a file first -- the catalogue rows are the
 * only record of which songs these were.
 *
 *   node scripts/remove-netease-unplayable.js          # show what would go
 *   node scripts/remove-netease-unplayable.js --apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const prisma = require('../src/db/client');
const creds = require('../src/services/musicCredentialService');

const APPLY = process.argv.includes('--apply');
const GAP_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, cookie) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: {
      'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/', Cookie: cookie,
    } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('bad json')); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const u = await prisma.user.findFirst({ where: { username: '小芳' }, select: { id: true } });
  const cred = await creds.getCredential(u.id, 'netease');
  if (!cred) throw new Error('no NetEase credential');

  const tracks = await prisma.importedTrack.findMany({
    where: { source: 'NETEASE' },
    select: { id: true, externalId: true, title: true, artist: true, playlistRef: true },
  });
  console.log(`NetEase tracks in the catalogue: ${tracks.length}`);

  const priv = new Map();
  for (let i = 0; i < tracks.length; i += 100) {
    if (i > 0) await sleep(GAP_MS);
    const slice = tracks.slice(i, i + 100);
    const c = slice.map((t) => ({ id: Number(t.externalId) }));
    const j = await get('https://music.163.com/api/v3/song/detail'
      + `?c=${encodeURIComponent(JSON.stringify(c))}`, cred.cookie);
    if (j.code === -460 || j.code === 405) {
      console.log(`throttled (code ${j.code}) — stopping without deleting anything.`);
      process.exit(1);
    }
    for (const p of j.privileges || []) priv.set(String(p.id), p);
  }
  console.log(`answered: ${priv.size}\n`);

  // plLevel names the best quality the track can actually play at, and reads
  // "none" when it cannot play at all. maxbr is not that field.
  const dead = tracks.filter((t) => {
    const p = priv.get(t.externalId);
    if (!p) return false;          // unanswered: leave it alone
    return !(p.st >= 0 && p.plLevel && p.plLevel !== 'none');
  });

  console.log(`unplayable: ${dead.length}`);
  for (const d of dead) console.log(`   ${d.title} — ${d.artist}  (${d.externalId})`);

  const maps = await prisma.songMapping.findMany({
    where: { source: 'NETEASE', externalId: { in: dead.map((d) => d.externalId) } },
  });
  console.log(`\nmappings pointing at them: ${maps.length}`);
  for (const m of maps) console.log(`   "${m.rawTitle} - ${m.rawArtist}"${m.approved ? ' (confirmed)' : ''}`);

  if (!dead.length) { await prisma.$disconnect(); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = path.join(__dirname, `../backups/removed-netease-unplayable-${stamp}.json`);
  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to remove them.');
    console.log(`A backup would be written to ${dump}`);
    await prisma.$disconnect();
    return;
  }

  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify({
    removedAt: new Date().toISOString(),
    reason: 'NetEase reports these as unplayable (st < 0 or plLevel none)',
    tracks: dead.map((d) => ({
      ...d, st: priv.get(d.externalId)?.st, plLevel: priv.get(d.externalId)?.plLevel,
    })),
    mappings: maps,
  }, null, 2), 'utf8');
  console.log(`\nbacked up to ${dump}`);

  // Mappings first: a catalogue row deleted while a mapping still names it
  // leaves the mapping resolving to nothing.
  const delMaps = maps.length
    ? await prisma.songMapping.deleteMany({ where: { id: { in: maps.map((m) => m.id) } } })
    : { count: 0 };
  const delTracks = await prisma.importedTrack.deleteMany({
    where: { id: { in: dead.map((d) => d.id) } },
  });
  console.log(`removed ${delMaps.count} mappings and ${delTracks.count} catalogue rows`);
  console.log(`catalogue now holds ${await prisma.importedTrack.count()} tracks`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FAILED:', String(e.message || e).slice(0, 300));
  await prisma.$disconnect();
  process.exit(1);
});
