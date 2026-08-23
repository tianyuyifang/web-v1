/**
 * For songs QQ will not play, find the NetEase track and say whether it plays.
 *
 * Second half of the audit that audit-qq-playable.js starts. That run left 218
 * of 3103 catalogue tracks unresolvable on QQ; this looks each one up on
 * NetEase and records what it finds, so the source on those rows can be
 * corrected afterwards.
 *
 *   node scripts/audit-netease-lookup.js           # first 20, to check quality
 *   node scripts/audit-netease-lookup.js --all
 *
 * Search runs anonymously; the playability check sends the user's cookie.
 *
 * It has to. Asked anonymously, NetEase reports tracks it will happily play as
 * st=-100, plLevel=none -- 疯人愿 and 风铃 both read as unplayable without a
 * cookie and as lossless and hires with one. An anonymous audit would have
 * condemned songs that work.
 *
 * That is the same cookie the site already sends to the same host to resolve
 * playback for this user, so the audit adds calls of a kind already being
 * made, not a new kind. What the October 2024 freezes punished was third-party
 * *login* -- web-api session creation with mismatched device headers -- and
 * this session was created months ago and has been in use since. No account
 * freeze in that corpus was attributed to request volume; volume produces
 * -460/405, which is IP-scoped, transient, and an error rather than a penalty.
 *
 * Two things are deliberately avoided. Playability is read from song/detail
 * rather than song/url, so no playback authorisation is ever requested. And
 * nothing here touches 打卡/签到/scrobble -- inflating listening counts is the
 * one behaviour NetEase has publicly committed to punishing, and the clients
 * that survived that wave stripped it out.
 *
 * Search cannot be batched, so this is one request per song; detail can, and
 * is fetched a hundred ids at a time. Three seconds between calls, one at a
 * time, matching the QQ half.
 *
 * Nothing is written to the database. The result is a file for a human to read
 * and, later, a separate step to act on.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

const ALL = process.argv.includes('--all');
const GAP_MS = 3000;
const DETAIL_BATCH = 100;
const IN = path.join(__dirname, '../backups/qq-playable-audit.json');
const OUT = path.join(__dirname, '../backups/netease-lookup.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, cookie) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://music.163.com/',
        ...(cookie ? { Cookie: cookie } : {}),
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
    }).on('error', reject);
  });
}

/** Strip what the two platforms disagree about, so titles can be compared. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[（(【[].*?[)）】\]]/g, '')   // (Live), 【伴奏】, [电影版]
    .replace(/\s+/g, '')
    .replace(/[·・,，.。!！?？~～\-_/|]/g, '');
}

/**
 * Rank a search hit against what the catalogue says.
 *
 * Title and artist both, because a title alone matches the wrong recording far
 * too easily: searching 第八秒 returns the song and 第八秒（和声伴奏）, and an
 * accompaniment track is the worst possible thing to hand someone about to
 * sing. Anything below a clean match on both is left for a person to confirm.
 */
function score(want, got) {
  const wt = norm(want.title);
  const gt = norm(got.name);
  const wa = norm(want.artist);
  const ga = norm((got.artists || []).map((a) => a.name).join('/'));

  let s = 0;
  if (wt && gt === wt) s += 60;
  else if (wt && (gt.includes(wt) || wt.includes(gt))) s += 30;

  if (wa && ga === wa) s += 40;
  else if (wa && ga && (ga.includes(wa) || wa.includes(ga))) s += 25;
  // A collaboration lists its singers in either order, so credit any overlap.
  else if (wa && ga && wa.split('/').some((p) => p && ga.includes(p))) s += 15;

  // Accompaniment and karaoke cuts share a title with the real thing and are
  // never what is wanted here.
  if (/伴奏|和声|karaoke|instrumental/i.test(got.name)) s -= 50;
  // Nor is a live recording, for the same reason at one remove: it carries the
  // title of the song someone means to sing but not its arrangement, and the
  // one this search turned up was delisted anyway. Docked rather than barred,
  // so it can still win when nothing else exists.
  if (/live|现场|演唱会|音乐会/i.test(got.name)) s -= 35;
  return s;
}

async function searchNetease(title, artist) {
  const q = encodeURIComponent(`${title} ${artist}`.trim());
  const j = await get(`https://music.163.com/api/search/get?s=${q}&type=1&limit=8`);
  return j?.result?.songs || [];
}

async function detailNetease(ids, cookie) {
  const c = ids.map((id) => ({ id: Number(id) }));
  const url = 'https://music.163.com/api/v3/song/detail'
    + `?c=${encodeURIComponent(JSON.stringify(c))}`;
  const j = await get(url, cookie);
  return j || {};
}

(async () => {
  const prisma = require('../src/db/client');
  const creds = require('../src/services/musicCredentialService');
  const user = await prisma.user.findFirst({
    where: { username: process.env.AUDIT_USER || '小芳' },
    select: { id: true, username: true },
  });
  const cred = user ? await creds.getCredential(user.id, 'netease') : null;
  if (!cred) throw new Error('that user has no NetEase credential');
  const cookie = cred.cookie;

  const src = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const dead = src.dead || [];
  const todo = ALL ? dead : dead.slice(0, 20);

  console.log(`QQ could not play: ${dead.length}`);
  console.log(`looking up:        ${todo.length}`);
  console.log(`pacing:            ${GAP_MS}ms, one at a time, no credential`);
  console.log(`estimate:          ~${Math.ceil(todo.length * GAP_MS / 1000)}s\n`);

  const found = [];
  for (let i = 0; i < todo.length; i++) {
    if (i > 0) await sleep(GAP_MS);
    const t = todo[i];
    let hits = [];
    try {
      hits = await searchNetease(t.title, t.artist);
    } catch (err) {
      console.log(`  ${i + 1}/${todo.length} ${t.title} -- search failed: ${err.message}`);
      found.push({ ...t, netease: null, note: 'search-failed' });
      continue;
    }
    const ranked = hits
      .map((h) => ({ h, s: score(t, h) }))
      .sort((a, b) => b.s - a.s);
    const best = ranked[0];
    if (!best || best.s < 60) {
      console.log(`  ${i + 1}/${todo.length} ${t.title} - ${t.artist}  -> no confident match`);
      found.push({ ...t, netease: null, note: 'no-match', bestScore: best ? best.s : null });
      continue;
    }
    found.push({
      ...t,
      netease: {
        id: best.h.id,
        name: best.h.name,
        artists: (best.h.artists || []).map((a) => a.name).join('/'),
        score: best.s,
        runnerUp: ranked[1] ? { name: ranked[1].h.name, score: ranked[1].s } : null,
      },
    });
    console.log(`  ${i + 1}/${todo.length} ${t.title} - ${t.artist}`
      + `  -> ${best.h.name} - ${(best.h.artists || []).map((a) => a.name).join('/')} (${best.s})`);
  }

  // Playability, batched, from metadata alone.
  const ids = found.filter((f) => f.netease).map((f) => f.netease.id);
  const priv = new Map();
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    if (i > 0) await sleep(GAP_MS);
    const chunk = ids.slice(i, i + DETAIL_BATCH);
    try {
      const j = await detailNetease(chunk, cookie);
      // -460 and 405 are NetEase saying "not so fast". They are IP-scoped and
      // temporary, but the answer to them is to stop, not to press on.
      if (j.code === -460 || j.code === 405) {
        console.log(`  detail batch: code ${j.code} (throttled) -- stopping here.`);
        break;
      }
      for (const p of j.privileges || []) priv.set(p.id, p);
    } catch (err) {
      console.log(`  detail batch failed: ${err.message}`);
    }
  }

  for (const f of found) {
    if (!f.netease) continue;
    const p = priv.get(f.netease.id);
    if (!p) { f.netease.playable = null; continue; }
    // plLevel is the field that answers this: it names the best quality the
    // track can actually be played at, and reads "none" when it cannot be
    // played at all. maxbr is not that field -- it reports 999000 for tracks
    // NetEase has no licence to play, so testing it would have called every
    // one of those playable. st < 0 marks a track taken down.
    f.netease.playable = p.st >= 0 && p.plLevel !== 'none' && !!p.plLevel;
    f.netease.fee = p.fee;
    f.netease.st = p.st;
    f.netease.plLevel = p.plLevel || null;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    checkedAt: new Date().toISOString(),
    fromAudit: src.checkedAt,
    considered: todo.length,
    results: found,
  }, null, 2), 'utf8');

  const matched = found.filter((f) => f.netease);
  const playable = matched.filter((f) => f.netease.playable === true);
  console.log(`\nlooked up ${todo.length}`);
  console.log(`  matched on NetEase:      ${matched.length}`);
  console.log(`  of those, playable:      ${playable.length}`);
  console.log(`  no confident match:      ${todo.length - matched.length}`);
  console.log(`\nwritten to ${OUT}`);
  await prisma.$disconnect();
})()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; });
