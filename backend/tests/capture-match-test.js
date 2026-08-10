/**
 * captureMatchService tests — pure, no DB needed.
 * Run: node tests/capture-match-test.js
 */
const assert = require('assert');
const {
  normTitle, compareTitles, matchTitle, foldWidth, splitEllipsis, FOLD_FROM, FOLD_TO,
} = require('../src/services/captureMatchService');

// --- normalisation ---
assert.strictEqual(normTitle('《山海》'), '山海', 'strips 《》');
assert.strictEqual(normTitle('十年（Live）'), '十年', 'strips bracketed suffix');
assert.strictEqual(normTitle('  想 见 你  '), '想见你', 'strips whitespace');
assert.strictEqual(normTitle(null), '', 'tolerates null');

// --- case 1: exact ---
assert.deepStrictEqual(compareTitles('山海', '山海').kind, 'exact');
assert.deepStrictEqual(compareTitles('《梦一场》', '梦一场').kind, 'exact', 'book marks ignored');
// Deliberately NOT exact any more: the bracket strip makes these equal, and it
// cannot distinguish "（Live）" from a subtitle like "(Break Free)". Matching is
// preserved; only the auto-approve privilege is withdrawn.
assert.deepStrictEqual(compareTitles('十年', '十年（Live）').kind, 'bracket',
  'bracketed suffix still matches, but needs a human');

// --- case 2: ellipsis (UI elided a long title) ---
let c = compareTitles('三角体…triangle', '三角体 triangle');
assert.strictEqual(c && c.kind, 'ellipsis');
c = compareTitles('漂洋过海…你', '漂洋过海来看你');
assert.strictEqual(c && c.kind, 'ellipsis');
c = compareTitles('想见你想...', '想见你想见你想见你');
assert.strictEqual(c && c.kind, 'ellipsis', 'trailing ellipsis with no suffix');

// --- case 3: loose (extra words on either side) ---
c = compareTitles('三角体', '三角体 triangle');
assert.strictEqual(c && c.kind, 'loose', 'library has extra words');
assert.ok(c.note.includes('曲库多了'), 'note says which side has extra: ' + c.note);
c = compareTitles('三角体 triangle', '三角体');
assert.strictEqual(c && c.kind, 'loose', 'game has extra words');
assert.ok(c.note.includes('游戏里多了'), 'note says which side: ' + c.note);
c = compareTitles('十年', '十年 演唱会版');
assert.strictEqual(c && c.kind, 'loose');

// --- must NOT match ---
assert.strictEqual(compareTitles('山海', '大海'), null, 'different titles');
assert.strictEqual(compareTitles('十', '十年之约'), null, 'single char is too weak to prefix-match');
assert.strictEqual(compareTitles('', '山海'), null, 'empty input');
// Seen in real data: "山海" was matching "山海侧". A one-character tail is a
// different song, not a version marker.
assert.strictEqual(compareTitles('山海', '山海侧'), null, 'one extra char is not a version marker');
assert.strictEqual(compareTitles('大海', '大海啸'), null, 'same, other direction');

// --- matchTitle: one candidate -> pending ---
let r = matchTitle('梦一场', [
  { id: 's1', title: '梦一场', artist: '那英' },
  { id: 's2', title: '大海', artist: '张雨生' },
]);
assert.strictEqual(r.outcome, 'pending');
assert.strictEqual(r.candidates.length, 1);
assert.strictEqual(r.candidates[0].artist, '那英');

// --- matchTitle: same title, different artists -> ambiguous ---
r = matchTitle('约定', [
  { id: 'a', title: '约定', artist: '王菲' },
  { id: 'b', title: '约定', artist: '周蕙' },
]);
assert.strictEqual(r.outcome, 'ambiguous', 'tv_songName has no artist, so both are candidates');
assert.strictEqual(r.candidates.length, 2);

// --- matchTitle: exact wins over loose ---
r = matchTitle('十年', [
  { id: 'x', title: '十年 演唱会版', artist: '陈奕迅' },
  { id: 'y', title: '十年', artist: '陈奕迅' },
]);
assert.strictEqual(r.outcome, 'pending', 'an exact match suppresses looser ones');
assert.strictEqual(r.candidates[0].songId, 'y');

// --- matchTitle: nothing found ---
r = matchTitle('库里没有这首歌', [{ id: 's1', title: '梦一场', artist: '那英' }]);
assert.strictEqual(r.outcome, 'no_match');
assert.strictEqual(r.candidates.length, 0);

// --- bracketed subtitle: matches, but must NOT be exact ---
// Found in real captures: 《挣脱》 auto-approved 挣脱 (Break Free), because the
// bracket strip cannot tell a version marker from part of the name.
c = compareTitles('挣脱', '挣脱 (Break Free)');
assert.strictEqual(c && c.kind, 'bracket', 'bracket-only equality is not exact');
c = compareTitles('枯', '枯（intro）');
assert.strictEqual(c && c.kind, 'bracket');
c = compareTitles('海底', '海底 (Deep)');
assert.strictEqual(c && c.kind, 'bracket');

// Both sides carrying the SAME bracket text is genuinely identical — still exact.
assert.strictEqual(
  compareTitles('挣脱 (Break Free)', '挣脱 (Break Free)').kind, 'exact',
  'identical titles stay exact even with brackets'
);
assert.strictEqual(
  compareTitles('《Intro（睡吧）》', 'Intro（睡吧）').kind, 'exact',
  'book marks still ignored; bracket content matches'
);

// An exact candidate must still win over a bracket one.
r = matchTitle('挣脱', [
  { id: 'b', title: '挣脱 (Break Free)', artist: 'A' },
  { id: 'e', title: '挣脱', artist: 'B' },
]);
assert.strictEqual(r.outcome, 'pending', 'the truly exact title wins outright');
assert.strictEqual(r.candidates[0].songId, 'e');

// --- punctuation width: matches, but must NOT be exact ---
// The game writes a half-width dot where the library holds a full-width one.
c = compareTitles('暂停.开始过', '暂停．开始过');
assert.strictEqual(c && c.kind, 'punct', 'half/full-width punctuation still matches');

// THE SAFETY GUARD. Only 'exact' is auto-approved by the UI, so a match that
// needed punctuation folding must never be reported as exact — otherwise
// widening the fold silently widens what gets liked without asking.
for (const [cap, lib] of [
  ['暂停.开始过', '暂停．开始过'],
  ['噢!拜托', '噢！拜托'],
  ['是我吗?', '是我吗？'],
  ['再说一次,我爱你', '再说一次，我爱你'],
]) {
  const got = compareTitles(cap, lib);
  assert.ok(got, `${cap} should match ${lib}`);
  assert.notStrictEqual(got.kind, 'exact', `${cap} vs ${lib} must not auto-approve`);
}

// Folding must not make unrelated titles match.
assert.strictEqual(compareTitles('你好,世界', '再见,世界'), null, 'folding does not merge unrelated');

// --- ellipsis must not fall through to prefix matching ---
// Real capture: "Rolling I...e Deep" starts with "roll", and the loose branch
// proposed the unrelated song "Roll" while hiding the correct one.
assert.strictEqual(
  compareTitles('Rolling I...e Deep', 'Roll'), null,
  'an elided capture must not prefix-match a short unrelated title'
);
c = compareTitles('Rolling I...e Deep', 'Rolling In The Deep');
assert.strictEqual(c && c.kind, 'ellipsis', 'the real song still matches');

// Ellipsis beats a bogus prefix candidate when both are offered.
r = matchTitle('Rolling I...e Deep', [
  { id: 'bad', title: 'Roll', artist: '袁娅维' },
  { id: 'good', title: 'Rolling In The Deep', artist: 'Adele' },
]);
assert.strictEqual(r.outcome, 'pending', 'only the real song survives');
assert.strictEqual(r.candidates.length, 1);
assert.strictEqual(r.candidates[0].songId, 'good');

// --- library titles containing … must survive folding ---
// NFKC would expand … into "..." and make every one of these look elided.
assert.strictEqual(foldWidth('嘘…'), '嘘…', 'ellipsis char is not folded');
assert.strictEqual(foldWidth('妈妈，我…'), '妈妈,我…', 'comma folds, ellipsis does not');
assert.strictEqual(splitEllipsis('嘘…') && splitEllipsis('嘘…').prefix, '嘘');

// --- the SQL fold table must agree with foldWidth ---
// They live in different languages; if they drift, the prefilter stops
// fetching songs the matcher would have paired up.
assert.strictEqual(FOLD_FROM.length, FOLD_TO.length, 'translate() needs equal-length maps');
for (let i = 0; i < FOLD_FROM.length; i++) {
  assert.strictEqual(
    foldWidth(FOLD_FROM[i]), FOLD_TO[i],
    `fold table disagrees with foldWidth at ${JSON.stringify(FOLD_FROM[i])}`
  );
}

console.log('capture-match tests passed');
