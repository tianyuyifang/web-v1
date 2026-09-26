/**
 * Re-key song_mappings.title_key from the loose pool rule to the mapping rule.
 *
 * song_mappings used to be keyed on normTitle, which strips bracketed suffixes,
 * so 无眠 and 无眠(国语版) shared one key and the unique (title_key, artist_key)
 * let only one of them exist. mappingTitleKey keeps the game's text (only 《》
 * and outer whitespace removed). This rewrites every stored key to match.
 *
 * Only song_mappings.title_key changes. imported_tracks, artist_key, ids,
 * sources and approval state are untouched; updated_at is not bumped.
 *
 *   node scripts/migrate-mapping-title-key.js                  dry run (default)
 *   node scripts/migrate-mapping-title-key.js --apply          write
 *   node scripts/migrate-mapping-title-key.js --rollback FILE  restore a backup (dry run)
 *     ... --rollback FILE --apply [--drop-conflicting]         write it; see rollback()
 *
 * ORDER MATTERS. The new code looks mappings up by the new key and the old code
 * by the old one, so code and data must switch together. With the backend
 * running on either side of a half-done switch, a lookup misses and the
 * resolver creates a second row for the same song, which then collides here.
 * So: git pull -> dry run -> pm2 stop music-backend -> --apply -> pm2 start.
 * Rolling back is the same in reverse: stop, --rollback, old code, start.
 *
 * --apply writes inside one transaction and checks, before committing, that
 * every row's key equals mappingTitleKey(raw_title) and that no (title_key,
 * artist_key) repeats. Either check failing rolls the whole thing back.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');
const { mappingTitleKey, titleKey, artistKey } = require('../src/services/songKeyService');
const { splitTitleArtist, loadDashedArtists } = require('../src/services/captureService');

const APPLY = process.argv.includes('--apply');
const rbIdx = process.argv.indexOf('--rollback');
const ROLLBACK = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;

const TEMP_PREFIX = '__migrating__:';

/** Keys that would repeat on (title_key, artist_key) given `keyOf`. */
function collisions(rows, keyOf) {
  const seen = new Map();
  for (const r of rows) {
    const k = `${keyOf(r)}\u0001${r.artistKey}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(r);
  }
  return [...seen.values()].filter((g) => g.length > 1);
}

/**
 * Two statements so no intermediate state can trip the unique index: first
 * every changing row moves to a key no real row can hold, then to its target.
 */
async function rekey(tx, ids, keys) {
  await tx.$executeRaw`
    UPDATE song_mappings SET title_key = ${TEMP_PREFIX} || id::text
     WHERE id = ANY(${ids}::uuid[])`;
  await tx.$executeRaw`
    UPDATE song_mappings m SET title_key = v.k
      FROM (SELECT unnest(${ids}::uuid[]) AS id, unnest(${keys}::text[]) AS k) v
     WHERE m.id = v.id`;
}

/** Throws unless the table is exactly `expected` (id -> key) and unique. */
async function assertKeys(tx, expectedOf) {
  const rows = await tx.$queryRaw`
    SELECT id::text AS id, raw_title, title_key, artist_key FROM song_mappings`;
  const wrong = rows.filter((r) => r.title_key !== expectedOf(r));
  if (wrong.length) {
    const ex = wrong.slice(0, 5).map((r) => `${r.raw_title} => ${r.title_key}`).join('; ');
    throw new Error(`${wrong.length} rows have an unexpected key, e.g. ${ex}`);
  }
  const dup = await tx.$queryRaw`
    SELECT title_key, artist_key, count(*)::int AS n FROM song_mappings
     GROUP BY title_key, artist_key HAVING count(*) > 1`;
  if (dup.length) throw new Error(`${dup.length} duplicate (title_key, artist_key) pairs`);
  return rows.length;
}

/**
 * What the change does to live captures: which game texts resolve before and
 * after. Same population and same split as the 未配置 page.
 */
async function liveImpact(rows) {
  const caps = await prisma.$queryRawUnsafe(
    `SELECT raw_text, count(*)::int AS seen FROM capture_events
      WHERE playlist_id IS NULL AND raw_text IS NOT NULL GROUP BY raw_text`);
  const known = await loadDashedArtists();
  const oldSet = new Map(rows.map((r) => [`${r.titleKey}\u0001${r.artistKey}`, r]));
  const newSet = new Set(rows.map((r) => `${mappingTitleKey(r.rawTitle)}\u0001${r.artistKey}`));
  const lost = [];
  let both = 0; let gained = 0; let neither = 0;
  for (const c of caps) {
    const { title, artist } = splitTitleArtist(c.raw_text, known);
    if (!titleKey(title)) continue;
    const ak = artistKey(artist);
    const oldK = `${titleKey(title)}\u0001${ak}`;
    const was = oldSet.get(oldK);
    const now = newSet.has(`${mappingTitleKey(title)}\u0001${ak}`);
    if (was && now) both += 1;
    else if (was) lost.push({ text: c.raw_text, seen: c.seen, was });
    else if (now) gained += 1;
    else neither += 1;
  }
  return { texts: caps.length, both, lost, gained, neither };
}

/**
 * Put the keys back under the old rule — a true inverse of --apply.
 *
 * Backed-up rows get their saved key. Rows created after the migration have no
 * saved key; they are moved to the old rule's key for their own game text
 * (titleKey(rawTitle)), because the old code can only ever find a row by that.
 * Left on the new rule they would be unreachable, and a later --apply would
 * trip over them.
 *
 * Some cannot move. Once versions are keyed apart, 十年 can gain its own row
 * beside 十年(Live); both fold to the old key 十年, which the restored
 * 十年(Live) takes. Such rows — a new row whose old key a restored row takes,
 * or all but the earliest of several new rows sharing one — are the conflicts.
 * They are listed, and removed only when --drop-conflicting says so (after
 * being saved, with any pool track they alone claimed handed back to 未遇见).
 */
async function rollback(file) {
  const DROP = process.argv.includes('--drop-conflicting');
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  const want = new Map(backup.rows.map((r) => [r.id, r.titleKey]));
  const current = await prisma.songMapping.findMany({
    select: {
      id: true, rawTitle: true, rawArtist: true, titleKey: true, artistKey: true,
      source: true, externalId: true, approved: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const extra = current.filter((r) => !want.has(r.id));

  // Old-rule homes: restored rows first, then new rows oldest-first.
  const taken = new Set(current.filter((r) => want.has(r.id))
    .map((r) => `${want.get(r.id)}\u0001${r.artistKey}`));
  const conflicting = [];
  const extraKey = new Map();
  for (const r of extra) {
    const k = `${titleKey(r.rawTitle)}\u0001${r.artistKey}`;
    if (taken.has(k)) { conflicting.push(r); continue; }
    taken.add(k);
    extraKey.set(r.id, titleKey(r.rawTitle));
  }
  const finalKey = (r) => (want.has(r.id) ? want.get(r.id) : extraKey.get(r.id));
  const kept = current.filter((r) => !conflicting.includes(r));
  const changing = kept.filter((r) => finalKey(r) !== r.titleKey);
  const stillColliding = collisions(kept, finalKey);

  console.log(`backup rows: ${backup.rows.length}, now in table: ${current.length}`);
  console.log(`rows to re-key: ${changing.length}`);
  console.log(`rows created after the backup: ${extra.length} (moved to the old rule: ${extraKey.size})`);
  console.log(`  of which cannot move (old key taken): ${conflicting.length}`);
  for (const r of conflicting) {
    console.log('   ', JSON.stringify(`${r.rawTitle} / ${r.rawArtist}`), r.source, r.externalId, r.approved ? 'approved' : 'pending');
  }
  if (stillColliding.length) {
    console.log(`\nABORT: ${stillColliding.length} collisions not explained by new rows. Nothing written.`);
    process.exitCode = 1;
    return;
  }
  if (conflicting.length && !DROP) {
    console.log('\nThese rows block the restore. Re-run with --drop-conflicting to save and');
    console.log('remove them (they are unreachable under the old code anyway). Nothing written.');
    if (APPLY) process.exitCode = 1;
    return;
  }
  if (!APPLY) { console.log('\nDry run. Add --apply to restore.'); return; }

  if (conflicting.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dump = path.join(__dirname, `../backups/mapping-title-key-dropped-${stamp}.json`);
    fs.mkdirSync(path.dirname(dump), { recursive: true });
    const full = await prisma.songMapping.findMany({ where: { id: { in: conflicting.map((r) => r.id) } } });
    fs.writeFileSync(dump, JSON.stringify(full, null, 1), 'utf8');
    console.log(`Saved ${full.length} rows to be removed to ${dump}`);
  }

  await prisma.$transaction(async (tx) => {
    if (conflicting.length) {
      await tx.songMapping.deleteMany({ where: { id: { in: conflicting.map((r) => r.id) } } });
      for (const r of conflicting) {
        const others = await tx.songMapping.count({ where: { source: r.source, externalId: r.externalId } });
        if (!others) {
          await tx.importedTrack.updateMany({
            where: { source: r.source, externalId: r.externalId },
            data: { matchedAt: null },
          });
        }
      }
    }
    if (changing.length) {
      await rekey(tx, changing.map((r) => r.id), changing.map(finalKey));
    }
    const expected = new Map(kept.map((r) => [r.id, finalKey(r)]));
    // A row that is in neither list appeared while this ran: fail, roll back.
    const n = await assertKeys(tx, (r) => (expected.has(r.id) ? expected.get(r.id) : `\u0000unexpected ${r.id}`));
    console.log(`verified ${n} rows`);
  }, { timeout: 120000 });
  console.log(`Restored${conflicting.length ? `, removed ${conflicting.length} new rows` : ''}.`);
}

async function migrate() {
  const rows = await prisma.songMapping.findMany({
    select: { id: true, rawTitle: true, rawArtist: true, titleKey: true, artistKey: true },
  });
  const target = (r) => mappingTitleKey(r.rawTitle);
  const changing = rows.filter((r) => r.titleKey !== target(r));
  const already = rows.filter((r) => r.titleKey === target(r));

  console.log(`song_mappings rows: ${rows.length}`);
  console.log(`  key changes: ${changing.length}`);
  console.log(`  already correct: ${already.length}`);

  const stale = rows.filter((r) => r.titleKey !== titleKey(r.rawTitle) && r.titleKey !== target(r));
  console.log(`  keys matching neither the old nor the new rule: ${stale.length}`);
  for (const r of stale.slice(0, 10)) console.log('     ', JSON.stringify(r.rawTitle), JSON.stringify(r.titleKey));

  const coll = collisions(rows, target);
  console.log(`  (title_key, artist_key) collisions after re-keying: ${coll.length}`);
  for (const g of coll.slice(0, 10)) {
    console.log('     ', g.map((r) => JSON.stringify(`${r.rawTitle} / ${r.rawArtist}`)).join('  |  '));
  }

  console.log('\nsample key changes (old -> new):');
  for (const r of changing.slice(0, 15)) {
    console.log('   ', JSON.stringify(r.titleKey), '->', JSON.stringify(target(r)));
  }

  if (!changing.length) {
    console.log('\nAlready migrated: every key matches the new rule. Nothing to do.');
    return;
  }

  // Only meaningful before the switch: it reads the stored keys as the old rule.
  const impact = await liveImpact(rows);
  console.log(`\nlive capture texts: ${impact.texts}`);
  console.log(`  resolve before and after: ${impact.both}`);
  console.log(`  resolve before, NOT after: ${impact.lost.length}`);
  console.log(`  resolve after only: ${impact.gained}`);
  console.log(`  resolve neither: ${impact.neither}`);
  for (const x of impact.lost) {
    console.log('   ', JSON.stringify(x.text), '-> used to hit', JSON.stringify(`${x.was.rawTitle} / ${x.was.rawArtist}`), `x${x.seen}`);
  }

  if (coll.length) {
    console.log('\nABORT: re-keying would break the unique constraint. Nothing written.');
    process.exitCode = 1;
    return;
  }
  if (stale.length) {
    console.log('\nABORT: some keys match neither rule — the table is not in the state this');
    console.log('migration was written for. Nothing written.');
    process.exitCode = 1;
    return;
  }
  if (!APPLY) { console.log('\nDry run. Nothing written. Add --apply to write.'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = path.join(__dirname, `../backups/mapping-title-key-${stamp}.json`);
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify({
    note: 'song_mappings.title_key before migrate-mapping-title-key.js',
    rows: rows.map((r) => ({ id: r.id, rawTitle: r.rawTitle, titleKey: r.titleKey })),
  }, null, 1), 'utf8');
  console.log(`\nBacked up ${rows.length} keys to ${dump}`);

  await prisma.$transaction(async (tx) => {
    if (changing.length) {
      await rekey(tx, changing.map((r) => r.id), changing.map(target));
    }
    const n = await assertKeys(tx, (r) => mappingTitleKey(r.raw_title));
    console.log(`verified ${n} rows before commit`);
  }, { timeout: 120000 });
  console.log(`Re-keyed ${changing.length} rows. Rollback: --rollback ${dump} --apply`);
}

(ROLLBACK ? rollback(ROLLBACK) : migrate())
  .catch((err) => { console.error('FAILED (nothing committed):', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
