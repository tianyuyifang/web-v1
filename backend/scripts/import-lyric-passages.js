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
const { hashPassage } = require('../src/services/lyricPassageStore');

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

  const n = lineCount(entry.gameLyric);
  if (entry.answer.length !== n) {
    return `${at} answer has ${entry.answer.length} entries for ${n} game lines`;
  }
  if (!entry.answer.every((v) => Number.isInteger(v) && v >= -1)) {
    return `${at} answer must be integers >= -1`;
  }
  if (entry.status === 'unmatchable' && entry.answer.some((v) => v >= 0)) {
    return `${at} unmatchable rows must not point anywhere`;
  }
  if (entry.status === 'approved' && entry.answer.every((v) => v < 0)) {
    return `${at} an approved answer that places nothing is unmatchable, not approved`;
  }
  // The lines an answer covers must be adjacent — a passage is sung as a run.
  // Six of the first twenty-seven answers failed this, all the same way: where
  // the platform wrote as two lines what the game showed as one, only the first
  // was recorded, so the run had a hole and the second line went unmarked.
  const used = [...new Set(entry.answer.filter((v) => v >= 0))].sort((a, b) => a - b);
  if (used.length && used[used.length - 1] - used[0] !== used.length - 1) {
    return `${at} answer covers ${used.join(',')} — a passage is sung as a run, so the lines must be adjacent`;
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
