const crypto = require('crypto');

/** Opaque capture-session token: 24 random bytes as 48 hex chars. */
function generateToken() {
  return crypto.randomBytes(24).toString('hex');
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

module.exports = { generateToken, hashToken, isExpired };
