/**
 * captureService.siteNameKey must stay identical to captureMatchService's
 * normTitleStrict: it decides which songs fetchCandidatesWithSameName adds to
 * a lookup, and the matcher then calls a match 'exact' by normTitleStrict.
 * If the two drift, a song of exactly the game title can again be missed
 * (or a song added that the matcher then ignores).
 *
 * Also: every library name, looked up as the game would show it (《name》),
 * finds its own song as an exact match -- the 29 names the prefilter alone
 * missed on 2026-11-17 ("【插曲】意难平", "你（正式版）", "Chéri", ...).
 *
 * Run: node tests/same-name-key-test.js   (reads the local database only)
 */
require('dotenv').config();
const fs = require('fs');
const assert = require('assert');
const prisma = require('../src/db/client');
const cap = require('../src/services/captureService');
const { matchTitle } = require('../src/services/captureMatchService');

function body(file, name) {
  const src = fs.readFileSync(require.resolve(file), 'utf8').replace(/\r/g, '');
  const i = src.indexOf(`function ${name}(`);
  assert(i >= 0, `${name} not found in ${file}`);
  let depth = 0;
  let j = src.indexOf('{', i);
  const start = j;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(start, j + 1);
}

(async () => {
  assert.strictEqual(
    body('../src/services/captureService', 'siteNameKey'),
    body('../src/services/captureMatchService', 'normTitleStrict'),
    'siteNameKey has drifted from normTitleStrict'
  );
  console.log('PASS siteNameKey is identical to normTitleStrict');

  const names = (await prisma.$queryRawUnsafe('SELECT DISTINCT title FROM songs')).map((r) => r.title);
  const missed = [];
  for (const t of names) {
    const text = `《${t}》`;
    const { candidates } = matchTitle(text, await cap.fetchCandidatesWithSameName(text));
    if (!candidates.some((c) => c.kind === 'exact')) missed.push(t);
  }
  assert.strictEqual(missed.length, 0, `names not found as exact: ${JSON.stringify(missed.slice(0, 20))}`);
  console.log(`PASS all ${names.length} library names find their own song as an exact match`);
  console.log('same-name-key tests passed');
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('FAILED:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
