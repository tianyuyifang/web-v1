/**
 * Short-lived cache of resolved playback URLs.
 *
 * Resolving the same track twice in a few minutes asks the platform a question
 * it already answered. That costs a round trip the listener waits through, and
 * more importantly it is one more request against an account we would rather
 * keep quiet — NetEase in particular has frozen accounts over third-party API
 * traffic, so the cheapest request is the one never sent.
 *
 * Keyed per user as well as per track, and that is not negotiable: a signed URL
 * is minted against the credential that asked for it, so handing one user's URL
 * to another would both fail and quietly share an account. The key is a hash of
 * the user id rather than the id itself, so a memory dump does not enumerate
 * who has connected what.
 *
 * In memory only. A restart loses it, which costs one extra resolve per track
 * and is not worth a database round trip to avoid.
 */
const crypto = require('crypto');

/**
 * How long an entry may be served.
 *
 * NetEase states 1200s outright. QQ states nothing and its vkey is opaque, so
 * the shorter, stated figure is used as the floor for both, halved again for
 * margin: an entry that outlives its URL turns into a playback failure the user
 * cannot explain, while an entry that expires early costs one cheap request.
 * Being wrong in the safe direction is nearly free here.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Ceiling on entries held.
 *
 * The cap exists so a long-running process cannot grow without bound; eviction
 * is oldest-first by insertion, which a Map gives us for free.
 *
 * Sized for singers, not for one session. Entries are per user AND per track,
 * so what matters is how many people are singing at once: ten people on the
 * same song hold ten entries, not one. Projected from measured use — 3 people
 * singing concurrently out of 11 active, one resolve per song, ~3.5 minutes a
 * song against a 10-minute TTL — 500 entries starts evicting live URLs at
 * roughly 800 users. Evicting one means re-resolving it, which is an avoidable
 * outbound call carrying the account's credential, so the cap is the one thing
 * here that turns growth into platform traffic.
 *
 * 5000 moves that point out of reach for any size this is likely to be, and
 * costs almost nothing: measured at 399 bytes an entry, the whole cache is
 * under 2MB against 1.1GB free on the host.
 */
const MAX_ENTRIES = 5000;

const entries = new Map();

/** Never store a raw user id; the cache only needs to tell users apart. */
function userKey(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
}

function keyOf(userId, source, externalId) {
  return `${userKey(userId)}:${source}:${externalId}`;
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of entries) {
    if (v.expiresAt <= now) entries.delete(k);
  }
}

/**
 * A still-valid URL for this user and track, or null.
 *
 * Only successful resolves are cached. A failure is not: the reason may be a
 * dead credential the user is about to fix, or a track the platform will serve
 * on the next attempt, and caching either would make the problem look permanent.
 */
function get(userId, source, externalId) {
  const hit = entries.get(keyOf(userId, source, externalId));
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    entries.delete(keyOf(userId, source, externalId));
    return null;
  }
  return hit.value;
}

function set(userId, source, externalId, value, ttlMs = DEFAULT_TTL_MS) {
  if (!value?.url) return value;

  sweep();
  if (entries.size >= MAX_ENTRIES) {
    // Oldest insertion first — Map preserves it, so no bookkeeping is needed.
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  entries.set(keyOf(userId, source, externalId), {
    value,
    expiresAt: Date.now() + Math.max(0, ttlMs),
  });
  return value;
}

/**
 * Drop everything cached for one user.
 *
 * Called when a credential is replaced or removed: URLs signed by the old one
 * are dead, and serving them would produce failures that look like the new
 * connection is broken.
 */
function clearUser(userId) {
  const prefix = `${userKey(userId)}:`;
  for (const k of entries.keys()) {
    if (k.startsWith(prefix)) entries.delete(k);
  }
}

/** Visible for tests and for a future status endpoint. */
function stats() {
  sweep();
  return { size: entries.size, max: MAX_ENTRIES, ttlMs: DEFAULT_TTL_MS };
}

module.exports = { get, set, clearUser, stats, DEFAULT_TTL_MS, MAX_ENTRIES };
