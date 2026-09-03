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

  // Contiguity. A passage is sung as a run, so the lines under it are a block.
  // This caught six of the first twenty-seven answers, all the same mistake:
  // where the platform wrote as two lines what the game showed as one, only the
  // first was recorded, leaving a hole in the run and the second line unmarked.
  assert.ok(store.isUsable([12, 13, 14], 3));
  assert.ok(store.isUsable([7, 7, 8], 3), 'two game lines may share one real line');
  assert.ok(store.isUsable([14, 12, 13], 3), 'the game shuffles; the block is what matters');
  assert.ok(store.isUsable([5, -1, 6], 3), 'an unplaced line does not break the run');
  assert.ok(!store.isUsable([11, 13], 2), 'a gap means these are not one passage');
  assert.ok(!store.isUsable([45, 47, 50, 53], 4));
  console.log('  ✓ an answer with a gap in it is refused');

  // A passage is usually sung more than once — 58% of measured passages occur
  // at least twice. An answer may therefore name several placements, and each
  // must be a run of its own; the gaps between them are the verses in between.
  assert.ok(store.isUsable([[5, 6, 7], [22, 23, 24]], 3), 'a chorus sung twice');
  assert.ok(store.isUsable([[5, 6], [22, 23], [40, 41]], 2), 'or three times');
  assert.ok(!store.isUsable([[5, 6, 7], [22, 24, 25]], 3),
    'a gap inside one placement is still a gap');
  assert.ok(!store.isUsable([[5, 6, 7], [22, 23]], 3),
    'every placement covers the whole passage');
  assert.ok(store.isUsable([[[5, 6], 7, 8], [[22, 23], 24, 25]], 3),
    'placements may each carry a one-to-many line');
  // The two shapes are told apart by the game's line count, not by nesting.
  // A placement has exactly one entry per game line.
  assert.deepStrictEqual(store.placementsOf([[63, 64], 65], 2), [[[63, 64], 65]]);
  assert.deepStrictEqual(store.placementsOf([[5, 6], [22, 23]], 2), [[5, 6], [22, 23]]);
  console.log('  ✓ several occurrences are kept apart, each a run of its own');

  // Counting is what settles it, because nesting alone cannot. Where every game
  // line spans two platform lines — 「第一天」 is written that way throughout —
  // one placement nests exactly like a list of placements. Read as six
  // occurrences of a six-line passage, each "occurrence" is two lines long and
  // the whole answer is thrown away, marking nothing.
  const 第一天 = [[4, 5], [5, 6, 7], [7, 8], [9, 10], [10, 11, 12], [12, 13]];
  assert.strictEqual(store.placementsOf(第一天, 6).length, 1,
    'six entries for a six-line passage is one placement, however it nests');
  assert.ok(store.isUsable(第一天, 6));

  // Where both readings are contiguous, one placement wins: a single run is the
  // stronger claim. 「我想你要走了」 stores this for two game lines, and lines
  // 11-14 are one passage — 「你要告别了把话说好了」 is [11] plus [12]. Read as
  // two placements it would draw two progress-bar dots for one occurrence.
  assert.strictEqual(store.placementsOf([[11, 12], [13, 14]], 2).length, 1);
  // The same shape with a gap between the pairs can only be two occurrences.
  assert.strictEqual(store.placementsOf([[5, 6], [22, 23]], 2).length, 2);
  console.log('  ✓ contiguity, not nesting, decides how many occurrences an answer names');

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
