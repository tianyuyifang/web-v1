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

  // 首末(ranges)型人工答案: 唱卡页只用首末, 中间行按连续性补。
  // 核心保证: ranges 渲染与等价逐行完全一致, 且旧逐行答案不受影响。
  const flat = (pls) => pls.map((pl) => pl.flatMap((v) => (Array.isArray(v) ? v : [v])));
  assert.deepStrictEqual(
    flat(store.placementsOf({ ranges: [[10, 14]] }, 3)),
    flat(store.placementsOf([10, 11, 12, 13, 14], 5)),
    'a range answer renders identically to its expanded per-line form');
  assert.ok(store.isUsable({ ranges: [[10, 14]] }, 3), 'a range ignores game line count on purpose');
  assert.ok(store.isUsable({ ranges: [[10, 12], [30, 32]] }, 3), 'several ranges for a chorus');
  assert.ok(!store.isUsable({ ranges: [[14, 10]] }, 3), 'first must not exceed last');
  assert.ok(!store.isUsable({ ranges: [] }, 3), 'an empty range list is not usable');
  assert.strictEqual(store.placementsOf({ ranges: [[10, 12], [30, 32]] }, 3).length, 2, 'two occurrences');
  console.log('  ✓ range answers render like per-line and keep the old format intact');

  // 变体: 同一段词的两种显示。游戏会把句子打乱, 或者盖掉一部分字 —— 人确认
  // 过一种之后, 另一种指的是真实歌词的同一片行, 答案原样可用。
  //
  // 判定必须是精确的。一首歌里真有两段不同的词时要分得开, 否则一次确认会把
  // 错答案铺到另一段上, 而那是直接生效给正在唱的人看的。
  const P = store.passageLines;

  assert.ok(store.isVariant(
    P('你是我触碰不到的风\n醒不来的梦\n忘不了的某某某'),
    P('醒不来的梦\n忘不了的某某某\n你是我触碰不到的风')),
    '打乱顺序仍是同一段');
  assert.ok(store.isVariant(
    P('你是我触碰不到的风\n醒不来的梦'),
    P('你 __ __ __ __\n醒不来的梦')),
    '盖掉一半的字仍是同一段');
  assert.ok(!store.isVariant(
    P('香榛丽大街\n如烟花坠落'),
    P('如 __ __\n香榛丽大街')),
    '乱序和遮掩同时发生, 这里不认 —— 游戏一次只用一种, '
    + '而两个不确定性叠在一起, 判错的代价是把答案直接铺给正在唱的人');
  console.log('  ✓ 乱序和遮掩都认得出是同一段');

  assert.ok(!store.isVariant(
    P('你是一只飞鸟飞上我的树梢\n从此我乏味的生活变得热闹'),
    P('我的山楂树之恋\n只有是和你才会纯洁')),
    '《山楂树之恋》那两段是真的两段词, 不能并');
  assert.ok(!store.isVariant(P('甲\n乙'), P('甲\n乙\n丙')),
    '行数不同就不是同一段');
  assert.ok(!store.isVariant(P('甲\n乙'), P('甲\n乙')),
    '一模一样的走精确查, 不该再当变体');
  assert.ok(!store.isVariant(P('我 __ __\n乙'), P('你是谁啊\n乙')),
    '遮掩剩下的字对不上, 不能当同一段');
  console.log('  ✓ 两段不同的词分得开');

  // 整行被盖光的段落不能当变体。visible() 去掉遮掩后剩空串, 而空串是任何
  // 字符串的前缀 —— 那一行会跟任何词都"相容"。实测两句全盖住的段落能同时
  // 匹配《山楂树之恋》和《你是一只飞鸟》, 而查询没有排序, 谁先返回谁赢。
  assert.strictEqual(store.variantKind(
    P('__ __ __\n__ __ __'),
    P('我的山楂树之恋\n只有是和你才会纯洁')), null,
    '盖光了的段落没有证据, 不能匹配任何词');
  assert.strictEqual(store.variantKind(
    P('__ __\n醒不来的梦'),
    P('你是我碰不到的风\n醒不来的梦')), null,
    '哪怕只有一行盖光, 那一行也无法比对');
  assert.strictEqual(store.variantKind(
    P('你 __ __\n醒不来的梦'),
    P('你是我碰不到的风\n醒不来的梦')), 'masked',
    '留下一个字就够了 —— 真实数据里正是每行留头一个字');
  console.log('  ✓ 盖光的行不当证据');

  // 乱序变体不能拿逐行答案来用。逐行的第 k 项说的是「游戏第 k 行对应哪一行」,
  // 句子一打乱就整个错位。《Raise Your Glass》两条已确认的正是这样: 覆盖的
  // 真实行都是 0,1,2, 答案却是 [0,0,1,1,2] 和 [1,1,0,2,0]。
  assert.strictEqual(store.variantKind(
    P('Right right\nturn off the lights\nWe are gonna lose'),
    P('turn off the lights\nWe are gonna lose\nRight right')), 'shuffled',
    '换了排列顺序, 就是乱序变体');
  assert.strictEqual(store.variantKind(
    P('你是我碰不到的风\n醒不来的梦'),
    P('你 __ __ __\n醒不来的梦')), 'masked',
    '盖掉几个字, 就是遮掩变体');
  console.log('  ✓ 分得清是乱序还是遮掩 —— 乱序只能用首末答案');

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

  // 队列里的段落, 哪怕同一首歌里躺着一条已确认的变体, 也不能顺着它拿到答案。
  // 变体兜底只服务于表里根本没有的段落 —— 一段词既然在等人判断, 系统就不该
  // 自己绕过那次判断; unmatchable 更是人明说过「没有对应」, 去匹配变体等于
  // 推翻结论。
  {
    const sibling = '你是我碰不到的风' + '\n' + '醒不来的梦';
    const shuffled = '醒不来的梦' + '\n' + '你是我碰不到的风';
    const hash = store.hashPassage(shuffled);
    await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT } });
    // 一条已确认的兄弟, 和一条正在排队的变体
    await prisma.lyricPassageMatch.create({
      data: { source: SOURCE, externalId: EXT, lyricHash: store.hashPassage(sibling),
        gameLyric: sibling, answer: { ranges: [[5, 6]] }, status: 'approved', verifiedBy: 'human' },
    });
    await prisma.lyricPassageMatch.create({
      data: { source: SOURCE, externalId: EXT, lyricHash: hash,
        gameLyric: shuffled, answer: [], status: 'pending', verifiedBy: 'ai' },
    });
    assert.strictEqual(await store.getApproved(SOURCE, EXT, shuffled, 2), null,
      '排队中的段落不能顺着已确认的兄弟拿到答案');
    // 同一段词若不在表里, 变体兜底才该生效
    await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT, lyricHash: hash } });
    assert.deepStrictEqual(await store.getApproved(SOURCE, EXT, shuffled, 2), { ranges: [[5, 6]] },
      '表里没有这段词时, 才轮到变体兑底');
    await prisma.lyricPassageMatch.deleteMany({ where: { externalId: EXT } });
    console.log('  ✓ 变体兑底不会绕过排队中的判断');
  }

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
