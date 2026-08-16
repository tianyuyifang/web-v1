/**
 * songKeyService tests — pure, no DB needed.
 * Run: node tests/song-key-test.js
 *
 * Most cases below are real strings read off the game and off QQ Music, not
 * invented ones. The mapping table is keyed on these values, so a change in
 * behaviour here silently splits one song into two rows or fuses two songs
 * into one — neither is visible until someone plays the wrong track.
 */
const assert = require('assert');
const {
  titleKey, artistKey, songKey, splitArtists, normOneArtist,
  artistsOverlap, isSeparatorAmbiguous,
} = require('../src/services/songKeyService');

// --- artist key: co-performer order must not matter -------------------------
// The game and the platforms order duets differently and neither is
// authoritative. Without the sort, one song becomes two mappings that each
// look correct in review.
assert.strictEqual(artistKey('汪苏泷/赵露思'), artistKey('赵露思/汪苏泷'), 'slash order');
assert.strictEqual(artistKey('周杰伦_费玉清'), artistKey('费玉清_周杰伦'), 'underscore order');
assert.strictEqual(artistKey('张杰/张碧晨'), artistKey('张碧晨、张杰'), 'slash vs ideographic comma');
assert.strictEqual(artistKey('A & B'), artistKey('B&A'), 'ampersand and spacing');
assert.strictEqual(artistKey('周深 feat. 王菲'), artistKey('王菲/周深'), 'feat. is a separator');
assert.strictEqual(artistKey('汪苏泷/赵露思'), '汪苏泷|赵露思', 'parts joined with |, sorted');

// --- artist key: distinct performers must NOT collide -----------------------
// The whole reason artist is part of the key.
assert.notStrictEqual(artistKey('王菲'), artistKey('李宇春'), '致青春 has two different singers');
assert.notStrictEqual(artistKey('汪苏泷'), artistKey('汪苏泷/赵露思'), 'solo is not the duet');

// Mixed-script names keep both halves: dropping the Latin part would fuse two
// artists who share a Chinese name, and a wrong fusion plays the wrong song
// forever, whereas a missed match merely queues for review.
assert.strictEqual(normOneArtist('朱婧汐 Akini Jing'), '朱婧汐akinijing');

// --- title key --------------------------------------------------------------
assert.strictEqual(titleKey('《换季》'), titleKey('换季'), 'game wraps 歌P titles in 《》');
assert.strictEqual(titleKey('心碎大道[中国好歌曲3]'), titleKey('心碎大道'), 'show tag stripped');
assert.strictEqual(titleKey('暂停.开始过'), titleKey('暂停．开始过'), 'full-width punctuation folded');
assert.strictEqual(titleKey(null), '', 'tolerates null');

// --- songKey keeps the raw forms -------------------------------------------
// Needed to re-key every row if these rules ever change; without them a
// normalisation fix would require the game data all over again.
const sk = songKey('  《致青春》 ', ' 王菲 ');
assert.strictEqual(sk.titleKey, '致青春');
assert.strictEqual(sk.artistKey, '王菲');
assert.strictEqual(sk.rawTitle, '《致青春》', 'raw title trimmed but otherwise untouched');
assert.strictEqual(sk.rawArtist, '王菲');

// --- separator ambiguity ----------------------------------------------------
// EVERY separator we split on also occurs inside real artist names: AC/DC,
// Simon & Garfunkel, and `_` which is this project's own separator. Splitting
// is a guess, so a single-separator name goes to a human rather than being
// decided silently.
const known = new Set([normOneArtist('周杰伦'), normOneArtist('费玉清')]);
assert.strictEqual(isSeparatorAmbiguous('周杰伦_费玉清', known), false, 'both halves known -> safe');
assert.strictEqual(isSeparatorAmbiguous('周杰伦_费玉清', new Set()), true, 'unknown halves -> ask');
assert.strictEqual(isSeparatorAmbiguous('A_', known), true, 'trailing _ is decoration, not a split');
assert.strictEqual(isSeparatorAmbiguous('_B', new Set()), true, 'leading separator likewise');
assert.strictEqual(isSeparatorAmbiguous('王菲', new Set()), false, 'no separator, nothing to guess');
assert.strictEqual(isSeparatorAmbiguous('', new Set()), false, 'blank is not ambiguous');
assert.strictEqual(isSeparatorAmbiguous(null, new Set()), false, 'tolerates null');
// A band whose name contains a slash. Nothing distinguishes it from a duet, so
// it must reach a human instead of being silently stored as two artists.
assert.strictEqual(isSeparatorAmbiguous('AC/DC', new Set()), true, 'slash inside a band name');
assert.strictEqual(isSeparatorAmbiguous('Simon & Garfunkel', new Set()), true, 'ampersand inside a name');
// Several separators read as a genuine list — that is what the separator is
// for, and 封茗囧菌/双笙/陈元汐 is a real shape from the imported playlist.
assert.strictEqual(isSeparatorAmbiguous('封茗囧菌/双笙/陈元汐', new Set()), false, 'multi-part list');

// --- inputs that will actually occur ---------------------------------------
// The game and the platforms both emit blanks and odd shapes; a key function
// that throws would take down a whole import batch.
assert.strictEqual(songKey('歌名', undefined).artistKey, '', 'undefined artist');
assert.strictEqual(songKey('歌名', null).artistKey, '', 'null artist');
assert.strictEqual(artistKey('///'), '', 'separators only');
assert.strictEqual(titleKey('《》'), '', 'title that is only book marks');
// Bracket-stripping can empty a name; it must not become a half-formed key.
assert.strictEqual(normOneArtist('(等什么君)'), '', 'artist that is only a bracket');

// --- idempotence ------------------------------------------------------------
// Keys get re-derived (re-import, re-normalisation); feeding a key back in
// must not change it, or rows would drift away from their own index.
for (const a of ['汪苏泷/赵露思', '周杰伦_费玉清', '朱婧汐 Akini Jing']) {
  assert.strictEqual(artistKey(artistKey(a)), artistKey(a), `artistKey idempotent: ${a}`);
}
for (const t of ['《换季》', '心碎大道[中国好歌曲3]', '暂停．开始过']) {
  assert.strictEqual(titleKey(titleKey(t)), titleKey(t), `titleKey idempotent: ${t}`);
}

// --- artist overlap ---------------------------------------------------------
// Looser than key equality on purpose: it only ranks candidates for review and
// never decides playback by itself.
assert.strictEqual(artistsOverlap('汪苏泷', '汪苏泷/赵露思'), true, 'platform added a feature artist');
assert.strictEqual(artistsOverlap('王菲', '李宇春'), false);
// The game says 凤凰传奇 where QQ says 玲花/曾毅 — no shared token, so no
// automatic match. This is exactly the case a human has to approve.
assert.strictEqual(artistsOverlap('凤凰传奇', '玲花/曾毅'), false, 'group name vs member names');
assert.strictEqual(artistsOverlap('', '王菲'), false, 'empty side never overlaps');

// --- splitting --------------------------------------------------------------
assert.deepStrictEqual(splitArtists('汪苏泷/赵露思'), ['汪苏泷', '赵露思']);
assert.deepStrictEqual(splitArtists('  '), [], 'blank yields nothing');
assert.deepStrictEqual(splitArtists('王菲//'), ['王菲'], 'empty parts dropped');

console.log('song-key tests passed');
