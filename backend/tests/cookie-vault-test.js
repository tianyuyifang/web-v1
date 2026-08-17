/**
 * cookieVault tests — pure, no DB.
 * Run: node tests/cookie-vault-test.js
 *
 * These protect other people's platform login cookies. Anyone holding one can
 * act as that user on QQ or NetEase, and the platforms ban accounts that look
 * shared, so the failure mode here is somebody's account, not our uptime.
 */
const assert = require('assert');
const crypto = require('crypto');

// Set before requiring, since the key is read on first use.
process.env.MUSIC_VAULT_KEY = crypto.randomBytes(32).toString('hex');
const vault = require('../src/utils/cookieVault');

// Shaped like a real cookie but entirely invented. Test fixtures end up in a
// public repository, and a platform uin identifies an account permanently.
const SECRET = 'qm_keyst=W_X_TESTVALUE_not_a_real_key_0000000000; uin=1000000000000000000';

// --- round trip -------------------------------------------------------------
const sealed = vault.encrypt(SECRET);
assert.strictEqual(vault.decrypt(sealed), SECRET, 'survives a round trip');
assert.ok(sealed.startsWith('v1.'), 'carries a version so the format can change later');
assert.ok(!sealed.includes(SECRET), 'plaintext is not sitting inside the payload');
assert.ok(!sealed.includes('qm_keyst'), 'not even a fragment leaks');

// A fresh IV each time, so identical cookies do not produce identical rows —
// otherwise anyone reading the table could tell which users share a login.
assert.notStrictEqual(vault.encrypt(SECRET), vault.encrypt(SECRET), 'ciphertext differs per call');

// --- realistic inputs -------------------------------------------------------
for (const value of [
  'a',
  'MUSIC_U=' + 'f'.repeat(600), // NetEase cookies are long
  '歌单=中文; k=v',              // non-ASCII survives
  JSON.stringify({ uin: '123', key: 'abc' }),
]) {
  assert.strictEqual(vault.decrypt(vault.encrypt(value)), value, `round trips: ${value.slice(0, 24)}`);
}

// --- tampering must fail, never yield a value -------------------------------
// GCM authenticates, so a row edited in the database is refused rather than
// decrypting to something an attacker chose.
const [v, iv, tag, data] = sealed.split('.');
const flip = (b64) => {
  const buf = Buffer.from(b64, 'base64url');
  buf[0] ^= 0xff;
  return buf.toString('base64url');
};

for (const [label, bad] of [
  ['ciphertext', [v, iv, tag, flip(data)].join('.')],
  ['auth tag', [v, iv, flip(tag), data].join('.')],
  ['iv', [v, flip(iv), tag, data].join('.')],
]) {
  assert.throws(() => vault.decrypt(bad), (e) => e.code === 'VAULT_DECRYPT_FAILED',
    `tampered ${label} is rejected`);
}

// --- malformed input --------------------------------------------------------
for (const bad of [null, undefined, 42, {}, '', 'garbage', 'v1.only.three', 'v2.a.b.c']) {
  assert.throws(() => vault.decrypt(bad), (e) => e.code === 'VAULT_BAD_PAYLOAD',
    `rejected: ${JSON.stringify(bad)}`);
}
assert.throws(() => vault.encrypt(''), (e) => e.code === 'VAULT_EMPTY_INPUT');
assert.throws(() => vault.encrypt(null), (e) => e.code === 'VAULT_EMPTY_INPUT');

// --- a different key cannot read it ----------------------------------------
// Confirms the key is actually load-bearing rather than the payload being
// readable by anyone who knows the format.
{
  const child = require('child_process').spawnSync(process.execPath, ['-e', `
    process.env.MUSIC_VAULT_KEY = require('crypto').randomBytes(32).toString('hex');
    const v = require('./src/utils/cookieVault');
    try { v.decrypt(process.argv[1]); console.log('DECRYPTED'); }
    catch (e) { console.log(e.code); }
  `, sealed], { encoding: 'utf8' });
  assert.strictEqual(child.stdout.trim(), 'VAULT_DECRYPT_FAILED', 'a different key cannot read it');
}

// --- key handling -----------------------------------------------------------
{
  const run = (key) => require('child_process').spawnSync(process.execPath, ['-e', `
    ${key === null ? 'delete process.env.MUSIC_VAULT_KEY;' : `process.env.MUSIC_VAULT_KEY=${JSON.stringify(key)};`}
    const v = require('./src/utils/cookieVault');
    try { v.encrypt('x'); console.log('OK'); } catch (e) { console.log(e.code); }
  `], { encoding: 'utf8' }).stdout.trim();

  assert.strictEqual(run(null), 'VAULT_KEY_MISSING', 'missing key is a clear error, not a silent default');
  assert.strictEqual(run('tooshort'), 'VAULT_KEY_INVALID', 'a short key is refused, never stretched');
  assert.strictEqual(run(crypto.randomBytes(32).toString('hex')), 'OK', 'hex key accepted');
  assert.strictEqual(run(crypto.randomBytes(32).toString('base64')), 'OK', 'base64 key accepted');
}

assert.strictEqual(vault.isConfigured(), true, 'reports configured when a key is present');

console.log('cookie-vault tests passed');
