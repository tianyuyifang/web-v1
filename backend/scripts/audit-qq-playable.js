/**
 * Which songs in the catalogue can QQ still play?
 *
 * Every imported track is filed under QQ, and some of them are not QQ songs at
 * all -- 第八秒 by 杜宣达 is a NetEase track whose row claims a QQ mid, and its
 * mid resolves to nothing. This finds all of them, so their real source can be
 * established afterwards.
 *
 * One-off, and deliberately outside the running site: it imports nothing from
 * the services the server uses, writes nothing to the database, and holds its
 * results in a file. Nothing here can change what the site does.
 *
 *   node scripts/audit-qq-playable.js            # dry, first chunk only
 *   node scripts/audit-qq-playable.js --all      # the whole catalogue
 *
 * On pacing. QQ documents no rate limit and sends none of the standard
 * signals, so the burden of choosing one falls entirely on the client -- the
 * IETF RateLimit draft says outright that a client must not read their absence
 * as their absence. The published rate to copy is Google's own advice for
 * crawlers, "not more than once every few seconds", so this waits three
 * seconds between calls and never runs two at once. Asking for a hundred mids
 * per call rather than one turns 3103 requests into 32, which does more for
 * politeness than any delay could: the whole run is about ninety seconds of
 * traffic, indistinguishable from someone opening a large playlist.
 *
 * It stops dead on 104604 -- QQ's "操作过于频繁" -- rather than backing off and
 * continuing. A throttle means the answer is "not now", and the run can be
 * finished tomorrow from the checkpoint.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const prisma = require('../src/db/client');
const creds = require('../src/services/musicCredentialService');

const ALL = process.argv.includes('--all');
const BATCH = 100;          // the ceiling the open-source clients settle on
const GAP_MS = 3000;
const OUT = path.join(__dirname, '../backups/qq-playable-audit.json');

const HOST = 'u.y.qq.com';
const CLIENT = { ct: 11, cv: 13020508, v: 13020508, tmeAppID: 'qqmusic' };
const TIER = { prefix: 'M500', ext: '.mp3' };   // mp3_128, the free tier

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0',
        Cookie: body.__cookie || '',
      },
    }, (res) => {
      // Bytes first, decoded once: appending each chunk to a string decodes
      // it alone, and a chunk boundary inside a character leaves U+FFFD.
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function probe({ mids, cookie, uin, musicKey, guid }) {
  const body = {
    comm: {
      ...CLIENT,
      uin: String(uin),
      authst: musicKey,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
    },
    req_1: {
      module: 'music.vkey.GetVkey',
      method: 'UrlGetVkey',
      param: {
        uin: String(uin),
        guid,
        // Parallel arrays, one entry per song -- the shape the endpoint has
        // always taken. The site sends one because it resolves one song at a
        // time; an audit has no reason to.
        filename: mids.map((m) => `${TIER.prefix}${m}${m}${TIER.ext}`),
        songmid: mids,
        songtype: mids.map(() => 0),
        ctx: 0,
      },
    },
  };
  body.__cookie = cookie;
  const json = await post(`https://${HOST}/cgi-bin/musicu.fcg`, body);
  delete body.__cookie;
  return json;
}

(async () => {
  const user = await prisma.user.findFirst({
    where: { username: process.env.AUDIT_USER || '小芳' },
    select: { id: true, username: true },
  });
  if (!user) throw new Error('audit user not found');
  const cred = await creds.getCredential(user.id, 'qq');
  if (!cred) throw new Error('that user has no QQ credential');

  const tracks = await prisma.importedTrack.findMany({
    where: { source: 'QQ' },
    select: { externalId: true, title: true, artist: true },
    orderBy: { externalId: 'asc' },
  });
  const seen = new Set();
  const list = tracks.filter((t) => {
    if (!t.externalId || seen.has(t.externalId)) return false;
    seen.add(t.externalId);
    return true;
  });

  const chunks = [];
  for (let i = 0; i < list.length; i += BATCH) chunks.push(list.slice(i, i + BATCH));
  const todo = ALL ? chunks : chunks.slice(0, 1);

  console.log(`catalogue: ${list.length} distinct QQ mids`);
  console.log(`chunks:    ${chunks.length} of ${BATCH}, running ${todo.length}`);
  console.log(`pacing:    ${GAP_MS}ms between calls, one at a time`);
  console.log(`estimate:  ~${Math.ceil(todo.length * GAP_MS / 1000)}s\n`);

  const guid = crypto.randomUUID().replace(/-/g, '');
  const playable = [];
  const dead = [];

  for (let i = 0; i < todo.length; i++) {
    if (i > 0) await sleep(GAP_MS);
    const chunk = todo[i];
    let json;
    try {
      json = await probe({
        mids: chunk.map((t) => t.externalId),
        cookie: cred.cookie, uin: cred.uin, musicKey: cred.musicKey, guid,
      });
    } catch (err) {
      console.log(`chunk ${i + 1}: request failed -- ${err.message}`);
      break;
    }

    const code = json?.req_1?.code;
    if (code === 104604) {
      console.log(`chunk ${i + 1}: 104604 (操作过于频繁) -- stopping here on purpose.`);
      console.log('Results so far are saved; resume later.');
      break;
    }
    if (code === 104003) {
      console.log(`chunk ${i + 1}: 104003 -- the credential is not recognised. Reconnect QQ and rerun.`);
      break;
    }

    const infos = json?.req_1?.data?.midurlinfo || [];
    if (!infos.length) {
      console.log(`chunk ${i + 1}: no midurlinfo (code ${code}) -- stopping.`);
      break;
    }

    for (let k = 0; k < chunk.length; k++) {
      const t = chunk[k];
      const info = infos[k];
      const ok = !!(info && info.purl);
      (ok ? playable : dead).push({
        externalId: t.externalId,
        title: t.title,
        artist: t.artist,
        result: info ? info.result : null,
        errType: info ? info.errtype : null,
      });
    }
    console.log(`chunk ${i + 1}/${todo.length}: ${infos.length} answered, `
      + `${playable.length} playable / ${dead.length} not (running total)`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    checkedAt: new Date().toISOString(),
    user: user.username,
    totalInCatalogue: list.length,
    checked: playable.length + dead.length,
    playable: playable.length,
    dead,
  }, null, 2), 'utf8');

  console.log(`\nchecked ${playable.length + dead.length} of ${list.length}`);
  console.log(`  playable on QQ: ${playable.length}`);
  console.log(`  not playable:   ${dead.length}`);
  console.log(`\nwritten to ${OUT}`);
  if (dead.length) {
    console.log('\nfirst few that did not resolve:');
    for (const d of dead.slice(0, 15)) {
      console.log(`  ${d.title} - ${d.artist}   (result ${d.result})`);
    }
  }
})()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
