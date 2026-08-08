const crypto = require('crypto');

/** Opaque capture-session token: 24 random bytes as 48 hex chars. */
function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Excludes 0/O and 1/I/L — the code is typed by hand inside an emulator,
// where a misread character means a failed pairing with no obvious cause.
const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Short human-typable pairing code, e.g. "4F7K2M". */
function generatePairCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return out;
}

/** SHA-256 hex. Only the hash is stored, never the token itself. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** A session is unusable once explicitly ended or past its expiry. */
function isExpired(session, now = new Date()) {
  if (!session) return true;
  if (session.endedAt) return true;
  return new Date(session.expiresAt).getTime() <= now.getTime();
}

module.exports = { generateToken, generatePairCode, hashToken, isExpired };
