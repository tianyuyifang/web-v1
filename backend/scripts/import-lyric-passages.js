/**
 * Load verified passage answers into the table.
 *
 * Input is a JSON array, each entry:
 *   { source, externalId, gameLyric, answer, status, verifiedBy?, note? }
 *
 * Every entry is checked before anything is written. A wrong answer here is
 * worse than no answer — the page would highlight the wrong lines with full
 * confidence — so the checks are refusals, not warnings:
 *
 *   - `answer` must have one entry per game line, all integers >= -1
 *   - `status` must be one of approved | pending | unmatchable
 *   - an `unmatchable` row may not claim to have found anything
 *
 * A human answer is never overwritten by a machine one: reviewers correct what
 * the assistant got wrong, and a later pass must not undo that.
 *
 * Dry by default. Pass --apply to write.
 *
 *   node scripts/import-lyric-passages.js verified.json
 *   node scripts/import-lyric-passages.js verified.json --apply
 */
require('dotenv').config();
const fs = require('fs');
const prisma = require('../src/db/client');
const {
  hashPassage, isUsable, coveredLines, placementsOf,
} = require('../src/services/lyricPassageStore');

const STATUSES = new Set(['approved', 'pending', 'unmatchable']);
const SOURCES = new Set(['LOCAL', 'QQ', 'NETEASE']);

/** How the page will split this passage — must match LiveLyrics.js exactly. */
function lineCount(gameLyric) {
  return String(gameLyric).split(/[\n\/]+/).map((l) => l.trim()).filter(Boolean).length;
}

function check(entry, i) {
  const at = `[${i}]`;
  if (!entry || typeof entry !== 'object') return `${at} not an object`;
  if (!SOURCES.has(entry.source)) return `${at} source must be LOCAL|QQ|NETEASE, got ${entry.source}`;
  if (!entry.externalId) return `${at} externalId missing`;
  if (!entry.gameLyric || !String(entry.gameLyric).trim()) return `${at} gameLyric empty`;
  if (!STATUSES.has(entry.status)) return `${at} status must be approved|pending|unmatchable`;
  if (!Array.isArray(entry.answer)) return `${at} answer must be an array`;

  // Length, shape and contiguity all come from the store, so the importer and
  // the page cannot drift apart on what a usable answer is. An answer is one
  // placement or several — a passage is usually sung more than once — and each
  // is one entry per game line: a line index, a list of them where the platform
  // wrote as several lines what the game showed as one, or -1 for none.
  //
  // Checking the top-level length here would be wrong, because for several
  // placements it is the number of occurrences, not of lines.
  const n = lineCount(entry.gameLyric);
  if (!isUsable(entry.answer, n)) {
    // Report against each placement: flattening the whole answer would show the
    // verses between occurrences as a gap in one of them.
    for (const place of placementsOf(entry.answer, n)) {
      if (!Array.isArray(place) || place.length !== n) {
        const got = Array.isArray(place) ? place.length : 'a non-list';
        return `${at} a placement has ${got} entries for ${n} game lines`;
      }
      const used = coveredLines(place);
      if (used.length && used[used.length - 1] - used[0] !== used.length - 1) {
        return `${at} a placement covers ${used.join(',')} — a passage is sung as a run, so the lines must be adjacent`;
      }
    }
    return `${at} answer entries must be a line index, a non-empty list of them, or -1`;
  }
  const placed = coveredLines(entry.answer);
  if (entry.status === 'unmatchable' && placed.length) {
    return `${at} unmatchable rows must not point anywhere`;
  }
  if (entry.status === 'approved' && !placed.length) {
    return `${at} an approved answer that places nothing is unmatchable, not approved`;
  }
  return null;
}

(async () => {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('usage: node scripts/import-lyric-passages.js <file.json> [--apply]');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : [];
  console.log(`${entries.length} entries from ${file}`);

  const problems = entries.map(check).filter(Boolean);
  if (problems.length) {
    console.error(`\nRefusing to import — ${problems.length} entries are malformed:`);
    problems.slice(0, 20).forEach((p) => console.error('  ' + p));
    process.exit(1);
  }
  console.log('all entries well-formed');

  let created = 0, updated = 0, keptHuman = 0;
  const byStatus = {};

  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    const lyricHash = hashPassage(e.gameLyric);
    const where = {
      source_externalId_lyricHash: { source: e.source, externalId: String(e.externalId), lyricHash },
    };
    const existing = await prisma.lyricPassageMatch.findUnique({
      where, select: { id: true, verifiedBy: true },
    });

    // A reviewer's own answer stands. The assistant may add rows, and may
    // revise its own, but it does not get to overrule a person.
    if (existing && existing.verifiedBy === 'human' && (e.verifiedBy || 'ai') !== 'human') {
      keptHuman++;
      continue;
    }

    if (!apply) { existing ? updated++ : created++; continue; }

    await prisma.lyricPassageMatch.upsert({
      where,
      create: {
        source: e.source,
        externalId: String(e.externalId),
        lyricHash,
        gameLyric: String(e.gameLyric),
        answer: e.answer,
        status: e.status,
        verifiedBy: e.verifiedBy || 'ai',
        note: e.note || null,
      },
      update: {
        answer: e.answer,
        status: e.status,
        verifiedBy: e.verifiedBy || 'ai',
        note: e.note || null,
        gameLyric: String(e.gameLyric),
      },
    });
    existing ? updated++ : created++;
  }

  console.log(`\nby status: ${JSON.stringify(byStatus)}`);
  console.log(`${apply ? 'wrote' : 'would write'}: ${created} new, ${updated} updated`);
  if (keptHuman) console.log(`kept ${keptHuman} reviewer answers untouched`);
  if (!apply) console.log('\ndry run — pass --apply to write');

  const total = await prisma.lyricPassageMatch.count().catch(() => null);
  if (total !== null) console.log(`table now holds ${total} rows`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('failed:', err.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
