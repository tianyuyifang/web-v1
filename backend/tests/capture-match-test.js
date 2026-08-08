/**
 * captureMatchService tests — pure, no DB needed.
 * Run: node tests/capture-match-test.js
 */
const assert = require('assert');
const { normTitle, compareTitles, matchTitle } = require('../src/services/captureMatchService');

// --- normalisation ---
assert.strictEqual(normTitle('《山海》'), '山海', 'strips 《》');
assert.strictEqual(normTitle('十年（Live）'), '十年', 'strips bracketed suffix');
assert.strictEqual(normTitle('  想 见 你  '), '想见你', 'strips whitespace');
assert.strictEqual(normTitle(null), '', 'tolerates null');

// --- case 1: exact ---
assert.deepStrictEqual(compareTitles('山海', '山海').kind, 'exact');
assert.deepStrictEqual(compareTitles('《梦一场》', '梦一场').kind, 'exact', 'book marks ignored');
assert.deepStrictEqual(compareTitles('十年', '十年（Live）').kind, 'exact',
  'bracketed suffix normalises away, so this is exact not loose');

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
assert.ok(c.note.includes('库里多了'), 'note says which side has extra: ' + c.note);
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

console.log('capture-match tests passed');
