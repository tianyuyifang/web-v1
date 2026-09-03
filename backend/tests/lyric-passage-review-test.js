/**
 * The review side: listing the queue and recording a decision.
 *
 * What matters here is that a reviewer's answer is trusted but still checked.
 * Trusted, because it outranks the assistant's and must survive later passes.
 * Checked, because an answer one line short misaligns every line after it, and
 * the page would show that with full confidence — worse than showing nothing.
 *
 * Run: node tests/lyric-passage-review-test.js
 */
require('dotenv').config();
const assert = require('assert');
const prisma = require('../src/db/client');
const review = require('../src/services/lyricPassageReview');
const { hashPassage } = require('../src/services/lyricPassageStore');

const EXT = '__test_review__';
const PASSAGE = '第一行\n第二行\n第三行';

async function seed(status, answer, verifiedBy = 'ai') {
  const lyricHash = hashPassage(PASSAGE);
  return prisma.lyricPassageMatch.upsert({
    where: { source_externalId_lyricHash: { source: 'QQ', externalId: EXT, lyricHash } },
    create: { source: 'QQ', externalId: EXT, lyricHash, gameLyric: PASSAGE, answer, status, verifiedBy },
    update: { answer, status, verifiedBy, note: null },
  });
}

(async () => {
  await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT } });

  // ---- listing ------------------------------------------------------------
  const row = await seed('pending', [1, 2, 3]);
  const page = await review.list({ status: 'pending', take: 50 });
  const mine = page.items.find((i) => i.id === row.id);
  assert.ok(mine, 'a pending row appears in the queue');
  assert.deepStrictEqual(mine.gameLines, ['第一行', '第二行', '第三行'],
    'the passage is split the way the page splits it');
  assert.ok(Array.isArray(mine.realLines), 'real lyrics come back with the row');
  console.log('  ✓ the queue carries everything needed to judge a row');

  const approvedPage = await review.list({ status: 'approved', take: 50 });
  assert.ok(!approvedPage.items.some((i) => i.id === row.id),
    'a pending row is not in the approved list');
  console.log('  ✓ the queue filters by status');

  // ---- a reviewer's decision ---------------------------------------------
  const ok = await review.decide(row.id, { status: 'approved', answer: [5, 6, 7], note: '断句差异' });
  assert.strictEqual(ok.status, 'approved');
  assert.deepStrictEqual(ok.answer, [5, 6, 7]);
  assert.strictEqual(ok.verifiedBy, 'human', "a reviewer's answer is recorded as theirs");
  assert.strictEqual(ok.note, '断句差异');
  console.log('  ✓ a decision is stored as the reviewer’s own');

  // ---- the checks that stop a misaligned answer ---------------------------
  await assert.rejects(
    () => review.decide(row.id, { status: 'approved', answer: [5, 6] }),
    /3 个数字/, 'an answer must cover every game line',
  );
  await assert.rejects(
    () => review.decide(row.id, { status: 'approved', answer: [5, 6, 'x'] }),
    /3 个数字/, 'an answer must be integers',
  );
  await assert.rejects(
    () => review.decide(row.id, { status: 'approved', answer: [-1, -1, -1] }),
    /at least one line/, 'an approved answer that places nothing is not approved',
  );
  await assert.rejects(
    () => review.decide(row.id, { status: 'nonsense' }),
    /status must be/, 'only the three statuses are accepted',
  );
  await assert.rejects(
    () => review.decide('11111111-1111-1111-1111-111111111111', { status: 'approved', answer: [1, 2, 3] }),
    /not found/i, 'an unknown row is a 404, not a silent create',
  );
  console.log('  ✓ an answer that would misalign the page is refused');

  // ---- unmatchable blanks the answer rather than contradicting itself -----
  const none = await review.decide(row.id, { status: 'unmatchable' });
  assert.strictEqual(none.status, 'unmatchable');
  assert.deepStrictEqual(none.answer, [-1, -1, -1],
    'saying there is no counterpart cannot leave one pointed at');
  console.log('  ✓ unmatchable clears the answer it contradicts');

  // ---- counts -------------------------------------------------------------
  const c = await review.counts();
  assert.ok(typeof c.pending === 'number' && typeof c.approved === 'number'
    && typeof c.unmatchable === 'number', 'counts cover every status');
  console.log('  ✓ counts cover every status');

  await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT } });
  console.log('\nAll passage-review tests passed.');
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('\nFAILED:', err.message);
  await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
