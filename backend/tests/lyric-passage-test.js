/**
 * The lyric-passage store, and the promise it makes to the 唱卡 page.
 *
 * The page has a matcher of its own and uses it whenever this store says
 * nothing, so the only way this can hurt is by answering when it should not.
 * These tests pin that: an answer comes back for an approved row and for
 * nothing else — not for a suggestion awaiting review, not for a passage known
 * to have no counterpart, not for an answer whose shape no longer fits.
 *
 * Run: node tests/lyric-passage-test.js
 */
require('dotenv').config();
const assert = require('assert');
const prisma = require('../src/db/client');
const store = require('../src/services/lyricPassageStore');

const SOURCE = 'QQ';
const EXT = '__test_passage__';
const PASSAGE = '第一行\n第二行\n第三行';

async function put(status, answer, verifiedBy = 'ai') {
  const lyricHash = store.hashPassage(PASSAGE);
  await prisma.lyricPassageMatch.upsert({
    where: { source_externalId_lyricHash: { source: SOURCE, externalId: EXT, lyricHash } },
    create: { source: SOURCE, externalId: EXT, lyricHash, gameLyric: PASSAGE, answer, status, verifiedBy },
    update: { answer, status, verifiedBy },
  });
}

(async () => {
  // ---- pure helpers, no database -----------------------------------------
  assert.strictEqual(store.hashPassage(PASSAGE), store.hashPassage(PASSAGE + '  '),
    'surrounding whitespace must not make a different passage');
  assert.notStrictEqual(store.hashPassage('甲\n乙'), store.hashPassage('乙\n甲'),
    'a reordered passage is a different passage: the answer is parallel to the lines');
  assert.notStrictEqual(store.hashPassage('春 __ __'), store.hashPassage('__ __ 回'),
    'different masking is different evidence');
  console.log('  ✓ passages are identified by their exact text');

  assert.ok(store.isUsable([0, 1, 2], 3));
  assert.ok(store.isUsable([-1, 4], 2), '-1 records a line with no counterpart');
  assert.ok(!store.isUsable([0, 1], 3), 'an answer must cover every game line');
  assert.ok(!store.isUsable([0, 'x'], 2));
  assert.ok(!store.isUsable([-2], 1), 'only -1 is a valid absence');
  assert.ok(!store.isUsable(null, 1));
  console.log('  ✓ an ill-fitting answer is refused');

  // ---- against the database ----------------------------------------------
  await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT } });

  assert.strictEqual(await store.getApproved(SOURCE, EXT, PASSAGE, 3), null,
    'an unknown passage answers nothing, so the page runs its matcher');
  console.log('  ✓ nothing stored, nothing said');

  await put('approved', [5, 6, 7]);
  assert.deepStrictEqual(await store.getApproved(SOURCE, EXT, PASSAGE, 3), [5, 6, 7],
    'an approved answer is what the page asked for');
  console.log('  ✓ an approved answer comes back');

  await put('pending', [5, 6, 7]);
  assert.strictEqual(await store.getApproved(SOURCE, EXT, PASSAGE, 3), null,
    'a suggestion awaiting review must never reach the page');
  await put('unmatchable', [-1, -1, -1]);
  assert.strictEqual(await store.getApproved(SOURCE, EXT, PASSAGE, 3), null,
    'a passage with no counterpart falls through to the matcher');
  console.log('  ✓ pending and unmatchable stay out of the page');

  await put('approved', [5, 6]);
  assert.strictEqual(await store.getApproved(SOURCE, EXT, PASSAGE, 3), null,
    'a stored answer that no longer fits is refused rather than misaligned');
  console.log('  ✓ a length mismatch is refused, not shifted');

  await put('approved', [5, 6, 7]);
  assert.strictEqual(await store.getApproved(SOURCE, EXT, '别的词', 3), null,
    'another passage of the same song is a different question');
  assert.strictEqual(await store.getApproved('NETEASE', EXT, PASSAGE, 3), null,
    'the same words under another recording are a different question');
  console.log('  ✓ answers are scoped to one passage of one recording');

  assert.strictEqual(await store.getApproved(null, EXT, PASSAGE, 3), null);
  assert.strictEqual(await store.getApproved(SOURCE, EXT, '', 3), null);
  console.log('  ✓ missing arguments answer nothing rather than throwing');

  await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT } });
  console.log('\nAll lyric-passage tests passed.');
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('\nFAILED:', err.message);
  await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
