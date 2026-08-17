/**
 * Encryption for third-party music credentials at rest.
 *
 * These are the user's own QQ / NetEase login cookies. They are not our
 * secrets to lose: anyone holding one can act as that person on the platform,
 * and the platforms ban accounts that look shared. So they are encrypted in
 * the database rather than stored as plain text, and no read path ever returns
 * one to the browser — the account page is told "connected" and nothing more.
 *
 * AES-256-GCM, which authenticates as well as encrypts: a row tampered with in
 * the database fails to decrypt instead of yielding an attacker-chosen value.
 *
 * The key lives in MUSIC_VAULT_KEY. Losing it costs every stored cookie, which
 * is recoverable — users reconnect — so it is deliberately not stored anywhere
 * that a database dump would carry with it.
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;
const VERSION = 'v1'; // lets the format change later without guessing

let cachedKey = null;

/**
 * The vault key, as raw bytes.
 *
 * Accepts a 64-char hex string or a base64 one, so operators can paste
 * whichever their tooling produced. Anything shorter than 32 bytes is refused
 * rather than stretched: a short key here would silently weaken every cookie
 * in the table.
 *
 * Cached after first use, so **changing MUSIC_VAULT_KEY needs a restart**.
 * Rotating it also strands every stored cookie — they were sealed under the
 * old key and will fail to decrypt. That is survivable (users reconnect) but
 * it is a deliberate choice, not an accident: re-encrypting on the fly would
 * mean holding both keys, and the value here is low enough that it is not
 * worth the complexity.
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.MUSIC_VAULT_KEY;
  if (!raw) {
    const err = new Error(
      'MUSIC_VAULT_KEY is not set. Generate one with: '
      + 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
    err.code = 'VAULT_KEY_MISSING';
    throw err;
  }

  let key;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');

  if (key.length !== KEY_BYTES) {
    const err = new Error(`MUSIC_VAULT_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
    err.code = 'VAULT_KEY_INVALID';
    throw err;
  }

  cachedKey = key;
  return key;
}

/** True when a key is configured and usable, for a startup check. */
function isConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a credential string.
 * Returns "v1.<iv>.<tag>.<ciphertext>", all base64url.
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    const err = new Error('Nothing to encrypt');
    err.code = 'VAULT_EMPTY_INPUT';
    throw err;
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a value produced by encrypt().
 *
 * Throws on tampering, on a wrong key, and on anything that is not in the
 * expected shape. Callers treat a throw as "this credential is unusable, ask
 * the user to reconnect" — never as a reason to fall back to something weaker.
 */
function decrypt(payload) {
  if (typeof payload !== 'string') {
    const err = new Error('Not an encrypted credential');
    err.code = 'VAULT_BAD_PAYLOAD';
    throw err;
  }
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    const err = new Error('Unrecognised credential format');
    err.code = 'VAULT_BAD_PAYLOAD';
    throw err;
  }
  const [, ivB64, tagB64, dataB64] = parts;

  try {
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    // Deliberately opaque: distinguishing "wrong key" from "tampered" would
    // tell an attacker with database access which one they got wrong. The
    // original is attached for server-side logs only.
    const err = new Error('Stored credential could not be read');
    err.code = 'VAULT_DECRYPT_FAILED';
    err.cause = cause;
    throw err;
  }
}

module.exports = {
  encrypt,
  decrypt,
  isConfigured,
  VERSION,
};
