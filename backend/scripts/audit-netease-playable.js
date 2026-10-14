/**
 * Which NetEase tracks in the catalogue will the platform not play? Report only.
 *
 * Step 4.5 of 导入 imported_tracks. remove-netease-unplayable.js answers the
 * same question, but it is also the script that deletes, so running even its
 * dry run means invoking a deleter -- and an automated reviewer that cannot
 * tell a dry run from --apply refuses it (2026-10-14). This one cannot delete
 * anything: it has no --apply, writes nothing to the database, and its only
 * output is the screen and a report file. Removing tracks stays a separate,
 * deliberate act with the other script.
 *
 * Two passes, because the first one is known to be wrong:
 *
 *   1. song/detail, 100 tracks a request -- the same screen the remover uses
 *      (st < 0, or plLevel "none"). Cheap, and on 2026-08-30 it condemned 7
 *      tracks that all played.
 *   2. For each track the first pass names, the real playback path the site
 *      itself uses (neteaseLogin.resolveUrl, same credential). Only a track
 *      that fails here too is reported as unplayable. Pass 1's verdict alone
 *      is never the answer.
 *
 * Tracks imported in the last 48 hours are marked, since right after an
 * import those are the ones in question.
 *
 *   node scripts/audit-netease-playable.js
 *
 * Pacing: three seconds between platform calls, one at a time, and it stops at
 * the first throttling answer -- same as the remover and the QQ audit.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const prisma = require('../src/db/client');
const creds = require('../src/services/musicCredentialService');
const netease = require('../src/services/sources/neteaseLogin');

const GAP_MS = 3000;
const NEW_MS = 48 * 3600 * 1000;
const REPORT = path.join(__dirname, '../backups/netease-playable-audit.json');
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
  const cred = u && await creds.getCredential(u.id, 'netease');
  if (!cred) throw new Error('no NetEase credential');

  const tracks = await prisma.importedTrack.findMany({
    where: { source: 'NETEASE' },
    select: { externalId: true, title: true, artist: true, createdAt: true },
  });
  const now = Date.now();
  const isNew = (t) => now - t.createdAt.getTime() < NEW_MS;
  console.log(`NetEase tracks in the catalogue: ${tracks.length} (new in 48h: ${tracks.filter(isNew).length})`);

  // --- pass 1: song/detail ---------------------------------------------------
  const priv = new Map();
  for (let i = 0; i < tracks.length; i += 100) {
    if (i > 0) await sleep(GAP_MS);
    const c = tracks.slice(i, i + 100).map((t) => ({ id: Number(t.externalId) }));
    const j = await get('https://music.163.com/api/v3/song/detail'
      + `?c=${encodeURIComponent(JSON.stringify(c))}`, cred.cookie);
    if (j.code === -460 || j.code === 405) {
      console.log(`throttled (code ${j.code}) — stopping.`);
      process.exit(1);
    }
    for (const p of j.privileges || []) priv.set(String(p.id), p);
  }
  const unanswered = tracks.filter((t) => !priv.has(t.externalId));
  const flagged = tracks.filter((t) => {
    const p = priv.get(t.externalId);
    return p && !(p.st >= 0 && p.plLevel && p.plLevel !== 'none');
  });
  console.log(`pass 1 (song/detail): answered ${priv.size}, flagged ${flagged.length}, unanswered ${unanswered.length}`);

  // --- pass 2: the real playback path, flagged tracks only ------------------
  const results = [];
  for (const t of flagged) {
    await sleep(GAP_MS);
    let verdict;
    try {
      const r = await netease.resolveUrl(t.externalId, { cookie: cred.cookie });
      if (r.reason === 'credential-expired') {
        console.log('NetEase credential expired — stopping; pass 2 results would mean nothing.');
        process.exit(1);
      }
      verdict = r.url ? 'plays' : (r.reason || 'no-url');
    } catch (e) {
      verdict = `error: ${String(e.code || e.message).slice(0, 40)}`;
    }
    const p = priv.get(t.externalId);
    results.push({ ...t, st: p?.st, plLevel: p?.plLevel, verdict, isNew: isNew(t) });
  }

  const dead = results.filter((r) => r.verdict === 'unavailable' || r.verdict === 'no-url');
  const membership = results.filter((r) => r.verdict === 'needs-login');
  const plays = results.filter((r) => r.verdict === 'plays');
  const errored = results.filter((r) => r.verdict.startsWith('error'));
  const line = (r) => `   ${r.isNew ? '[NEW] ' : ''}${r.title} — ${r.artist}  (${r.externalId})`;

  console.log(`\npass 2 (real resolve) on the ${flagged.length} flagged:`);
  console.log(`  plays after all (pass 1 was wrong): ${plays.length}`);
  for (const r of plays) console.log(line(r));
  console.log(`  member track, no url (credential's membership, not delisted): ${membership.length}`);
  for (const r of membership) console.log(line(r));
  console.log(`  no url on the real path (unplayable): ${dead.length}`);
  for (const r of dead) console.log(line(r));
  if (errored.length) {
    console.log(`  could not tell (request failed): ${errored.length}`);
    for (const r of errored) console.log(`${line(r)}  ${r.verdict}`);
  }

  const maps = await prisma.songMapping.findMany({
    where: { source: 'NETEASE', externalId: { in: dead.map((d) => d.externalId) } },
    select: { rawTitle: true, rawArtist: true, approved: true, externalId: true },
  });
  if (dead.length) {
    console.log(`\nmappings pointing at the unplayable: ${maps.length}`);
    for (const m of maps) console.log(`   "${m.rawTitle} - ${m.rawArtist}"${m.approved ? ' (confirmed)' : ''}`);
  }
  const newBad = [...dead, ...membership].filter((r) => r.isNew);
  console.log(`\nnew in 48h and not playing: ${newBad.length}`);

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({
    at: new Date().toISOString(),
    catalogue: tracks.length,
    unanswered: unanswered.map((t) => t.externalId),
    flagged: results,
    mappingsOnUnplayable: maps,
  }, null, 2), 'utf8');
  console.log(`report: ${REPORT}`);
  console.log('Nothing was changed. To remove tracks, use remove-netease-unplayable.js deliberately.');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FAILED:', String(e.message || e).slice(0, 300));
  await prisma.$disconnect();
  process.exit(1);
});
