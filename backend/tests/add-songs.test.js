const assert = require('assert');
const { matchSong } = require('../scripts/lib/add-songs');

(async () => {
  const s1 = { id: 'a', title: 'T', artist: '周杰伦' };
  const byTitle = new Map([['T', [s1]]]);

  // (a) artist match
  assert.strictEqual(await matchSong('T', '周杰伦', byTitle), s1, 'artist match returns the song');
  // (a') partial/fuzzy artist match (includes)
  assert.strictEqual(await matchSong('T', '周杰伦_费玉清', byTitle), s1, 'fuzzy multi-artist match');
  // (b) single candidate, no artist match → fallback to it
  assert.strictEqual(await matchSong('T', 'nobody', byTitle), s1, 'single candidate fallback');
  // (b') no artist string at all, single candidate
  assert.strictEqual(await matchSong('T', '', byTitle), s1, 'no artist, single candidate');
  // (c) title not in map → null
  assert.strictEqual(await matchSong('X', 'a', byTitle), null, 'not found returns null');

  console.log('add-songs.test OK');
})().catch((e) => { console.error(e); process.exit(1); });
