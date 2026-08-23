/**
 * Re-check the leftovers against every quality tier QQ offers.
 *
 * The main audit asked only for mp3_128, the free tier, and called anything
 * that did not come back unplayable. That is the wrong question to ask on
 * behalf of a green-diamond member: a track licensed only at higher quality
 * answers nothing at 128k and plays perfectly at 320k or lossless. Nine of the
 * songs it gave up on are 华晨宇 and two are 林俊杰, which is not the shape of
 * a catalogue QQ has no rights to.
 *
 * So the 38 it could not place anywhere are asked again, once per tier. Four
 * batched requests for all of them rather than 152 -- the endpoint takes
 * arrays, and asking about a hundred songs at once is gentler than asking
 * about one a hundred times.
 *
 *   node scripts/audit-qq-retry-tiers.js
 *
 * Reads the two audit files, writes a third. Touches no table.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const prisma = require('../src/db/client');
const creds = require('../src/services/musicCredentialService');

const GAP_MS = 3000;
const LOOKUP = path.join(__dirname, '../backups/netease-lookup.json');
const OUT = path.join(__dirname, '../backups/qq-retry-tiers.json');

const HOST = 'u.y.qq.com';
const CLIENT = { ct: 11, cv: 13020508, v: 13020508, tmeAppID: 'qqmusic' };
const TIERS = {
  m4a: { prefix: 'C400', ext: '.m4a' },
  mp3_128: { prefix: 'M500', ext: '.mp3' },
  mp3_320: { prefix: 'M800', ext: '.mp3' },
  flac: { prefix: 'F000', ext: '.flac' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(url, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0',
        Cookie: cookie,
      },
    }, (res) => {
      // Bytes first, decoded once: appending each chunk to a string decodes
      // it alone, and a chunk boundary inside a character leaves U+FFFD.
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const d = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 160))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  const user = await prisma.user.findFirst({
    where: { username: process.env.AUDIT_USER || '小芳' },
    select: { id: true, username: true },
  });
  const cred = await creds.getCredential(user.id, 'qq');
  if (!cred) throw new Error('that user has no QQ credential');

  const lookup = JSON.parse(fs.readFileSync(LOOKUP, 'utf8'));
  const left = lookup.results.filter(
    (r) => !r.netease || r.netease.playable !== true
  );
  console.log(`still unplaced after the NetEase pass: ${left.length}`);
  console.log(`asking QQ again at ${Object.keys(TIERS).length} tiers, `
    + `one batched request each\n`);

  const guid = crypto.randomUUID().replace(/-/g, '');
  const mids = left.map((r) => r.externalId);
  const won = new Map();   // mid -> the first tier that answered

  for (const [name, t] of Object.entries(TIERS)) {
    await sleep(GAP_MS);
    const body = {
      comm: {
        ...CLIENT,
        uin: String(cred.uin),
        authst: cred.musicKey,
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
      },
      req_1: {
        module: 'music.vkey.GetVkey',
        method: 'UrlGetVkey',
        param: {
          uin: String(cred.uin),
          guid,
          filename: mids.map((m) => `${t.prefix}${m}${m}${t.ext}`),
          songmid: mids,
          songtype: mids.map(() => 0),
          ctx: 0,
        },
      },
    };
    let json;
    try {
      json = await post(`https://${HOST}/cgi-bin/musicu.fcg`, body, cred.cookie);
    } catch (err) {
      console.log(`${name}: request failed -- ${err.message}`);
      continue;
    }
    const code = json?.req_1?.code;
    if (code === 104604) {
      console.log(`${name}: 104604 (操作过于频繁) -- stopping.`);
      break;
    }
    const infos = json?.req_1?.data?.midurlinfo || [];
    let hits = 0;
    for (let i = 0; i < mids.length; i++) {
      const info = infos[i];
      if (info && info.purl && !won.has(mids[i])) {
        won.set(mids[i], name);
        hits++;
      }
    }
    console.log(`${name}: ${hits} newly playable (${won.size}/${mids.length} so far)`);
  }

  const rescued = [];
  const stillDead = [];
  for (const r of left) {
    const tier = won.get(r.externalId);
    (tier ? rescued : stillDead).push({
      title: r.title, artist: r.artist, externalId: r.externalId,
      tier: tier || null,
      neteaseId: r.netease ? r.netease.id : null,
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    checkedAt: new Date().toISOString(),
    considered: left.length,
    rescued, stillDead,
  }, null, 2), 'utf8');

  console.log(`\nof ${left.length} leftovers:`);
  console.log(`  playable on QQ at some tier: ${rescued.length}`);
  console.log(`  still nowhere:               ${stillDead.length}`);
  if (rescued.length) {
    console.log('\nrescued:');
    for (const r of rescued) console.log(`  ${r.title} - ${r.artist}  (${r.tier})`);
  }
  console.log(`\nwritten to ${OUT}`);
})()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
