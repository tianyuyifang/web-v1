/**
 * neteaseLogin.mergeCookies — offline.
 * Run: node tests/netease-cookie-test.js
 *
 * The login response repeats MUSIC_R_T / MUSIC_A_T once per domain and path;
 * joined as they arrived, every scanned account carried a 28-key cookie with
 * 7 distinct names (76 of 76 measured on 2026-09-27). One value per name.
 */
const assert = require('assert');
const { mergeCookies } = require('../src/services/sources/neteaseLogin');

const lines = [
  'MUSIC_R_T=1; Max-Age=1; Expires=x; Path=/eapi/feedback',
  'MUSIC_A_T=1; Path=/eapi/feedback',
  'MUSIC_R_T=2; Path=/api/feedback',
  'MUSIC_A_T=2; Path=/api/feedback',
  'MUSIC_U=uvalue; Path=/; HttpOnly',
  '__csrf=abc; Path=/',
  'MUSIC_R_T=3; Path=/',
];

let c = mergeCookies('', lines);
let keys = c.split('; ').map((s) => s.split('=')[0]);
assert.deepStrictEqual(keys, ['MUSIC_R_T', 'MUSIC_A_T', 'MUSIC_U', '__csrf'], 'one entry per name, first-seen order');
assert.strictEqual(keys.length, new Set(keys).size, 'no duplicate names');
assert.ok(/(^|; )MUSIC_R_T=3(;|$)/.test(c), 'last value wins');
assert.ok(/(^|; )MUSIC_U=uvalue(;|$)/.test(c), 'MUSIC_U kept');

// Refresh: names the response does not mention keep what they had.
c = mergeCookies('MUSIC_U=old; __csrf=abc; NMTID=n1', ['MUSIC_U=new; Path=/']);
assert.strictEqual(c, 'MUSIC_U=new; __csrf=abc; NMTID=n1', 'merged onto the existing cookie');

// A refresh that reissues nothing leaves the cookie as it was.
assert.strictEqual(mergeCookies('MUSIC_U=old; __csrf=abc', []), 'MUSIC_U=old; __csrf=abc');

// Junk lines are ignored rather than producing empty names.
assert.strictEqual(mergeCookies('', ['', '=x', 'A=1']), 'A=1');

console.log('netease-cookie tests passed');
