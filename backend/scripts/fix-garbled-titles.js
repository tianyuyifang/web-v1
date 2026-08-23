/**
 * Re-fetch the titles that were stored broken.
 *
 * Twelve catalogue rows contain U+FFFD -- "123���Ҵ��", "陪你去流浪 -
 * ���之谦". That character is what a decoder writes when it meets bytes it
 * cannot read, so the original characters were discarded at import time and
 * nothing in the database can bring them back. They have to come from QQ again.
 *
 * The mid is intact in every case -- it is ASCII, so whatever mangled the
 * Chinese left it alone -- and all twelve resolve to a playable track, so QQ
 * still knows these songs. One batched call to the track-info module returns
 * every name and singer at once.
 *
 * That module rather than the vkey one: it reads catalogue metadata and asks
 * for no playback authorisation, which is the lighter thing to be doing and
 * the right one when the question is only what a song is called.
 *
 *   node scripts/fix-garbled-titles.js            # show what would change
 *   node scripts/fix-garbled-titles.js --apply
 */
require('dotenv').config();
const https = require('https');
const prisma = require('../src/db/client');
const creds = require('../src/services/musicCredentialService');

const APPLY = process.argv.includes('--apply');
const HOST = 'u.y.qq.com';
const CLIENT = { ct: 11, cv: 13020508, v: 13020508, tmeAppID: 'qqmusic' };

function post(url, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0',
        Cookie: cookie,
      },
    }, (res) => {
      // Collected as bytes and decoded once at the end. Decoding each chunk as
      // it arrives is how text gets mangled in the first place: a chunk
      // boundary can fall inside a multi-byte character, and each half then
      // decodes to U+FFFD -- which is exactly the damage this script exists to
      // repair.
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('bad json: ' + text.slice(0, 160))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  const rows = await prisma.importedTrack.findMany({
    where: { OR: [{ title: { contains: '�' } }, { artist: { contains: '�' } }] },
    select: { id: true, externalId: true, title: true, artist: true, matchedAt: true },
  });
  if (!rows.length) { console.log('no garbled rows'); return; }
  console.log(`garbled rows: ${rows.length}`);
  console.log(`  already claimed by a mapping: ${rows.filter((r) => r.matchedAt).length}\n`);

  const user = await prisma.user.findFirst({
    where: { username: process.env.AUDIT_USER || '小芳' },
    select: { id: true },
  });
  const cred = await creds.getCredential(user.id, 'qq');
  if (!cred) throw new Error('that user has no QQ credential');

  const mids = rows.map((r) => r.externalId);
  const json = await post(`https://${HOST}/cgi-bin/musicu.fcg`, {
    comm: {
      ...CLIENT,
      uin: String(cred.uin),
      authst: cred.musicKey,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
    },
    req_1: {
      module: 'music.trackInfo.UniformRuleCtrl',
      method: 'CgiGetTrackInfo',
      param: {
        ctx: 0,
        client: 1,
        mids,
        types: mids.map(() => 0),
        modify_stamp: mids.map(() => 0),
      },
    },
  }, cred.cookie);

  const code = json?.req_1?.code;
  const tracks = json?.req_1?.data?.tracks || [];
  if (!tracks.length) {
    console.log(`no tracks came back (code ${code}).`);
    console.log(JSON.stringify(json).slice(0, 400));
    return;
  }

  const byMid = new Map();
  for (const t of tracks) {
    byMid.set(t.mid, {
      title: t.name || t.title || '',
      artist: (t.singer || []).map((s) => s.name).filter(Boolean).join('/'),
    });
  }

  const fixes = [];
  for (const r of rows) {
    const fresh = byMid.get(r.externalId);
    if (!fresh || !fresh.title) {
      console.log(`  ?  ${r.title} — ${r.artist}   (QQ returned nothing)`);
      continue;
    }
    // Only if the replacement is clean. Writing one U+FFFD over another would
    // spend the request and leave the row as broken as it was.
    if (fresh.title.includes('�') || fresh.artist.includes('�')) {
      console.log(`  ?  ${r.title} — ${r.artist}   (QQ's copy is broken too)`);
      continue;
    }
    fixes.push({ id: r.id, from: `${r.title} — ${r.artist}`, ...fresh });
    console.log(`  ${r.title} — ${r.artist}`);
    console.log(`    -> ${fresh.title} — ${fresh.artist}`);
  }

  if (!APPLY) {
    console.log(`\nDry run. ${fixes.length} of ${rows.length} would be rewritten.`);
    console.log('Re-run with --apply to write them.');
    return;
  }

  for (const f of fixes) {
    await prisma.importedTrack.update({
      where: { id: f.id },
      data: { title: f.title, artist: f.artist },
    });
  }
  console.log(`\nrewrote ${fixes.length} rows`);

  const left = await prisma.importedTrack.count({
    where: { OR: [{ title: { contains: '�' } }, { artist: { contains: '�' } }] },
  });
  console.log(`rows still garbled: ${left}`);
})()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
