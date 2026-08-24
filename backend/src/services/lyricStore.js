/**
 * Platform lyrics, fetched once and kept in the imported-track row.
 *
 * Why storage rather than a cache: the lyric call is the only outbound path
 * that carries no credential at all. Playback resolution burns the listener's
 * own account, which is theirs to spend — a lyric request leaves as the server,
 * over the one address every user shares, and these platforms rate-limit by
 * address rather than by account. Measured before this existed: 7.2 requests a
 * second sustained, about 26k an hour, all charged to this machine.
 *
 * An in-memory cache would have been the smaller change and the wrong one. It
 * empties on restart, so every card opened after a deploy goes back to the
 * platform at once — the exact burst worth avoiding, arriving exactly when the
 * process is least able to absorb it. Lyrics do not change, so there is nothing
 * a TTL would buy.
 *
 * Only tracks in the imported pool can be stored, which is every track the
 * review and 唱卡 pages can name: both resolve through it. A pair that is not
 * in the pool still answers, it just answers from the platform every time.
 */
const prisma = require('../db/client');

/**
 * Ceiling on a stored lyric.
 *
 * Nothing about the platform's answer is under our control, and a `text` column
 * will hold a megabyte as readily as a kilobyte. Real lyrics measured 1164
 * characters on average and 2451 at the longest across the catalogue, so this
 * is roughly four times the worst real case — high enough that no real song is
 * touched, low enough that a malformed or hostile response cannot fill a disk
 * one row at a time.
 *
 * Truncation is silent and deliberate: a lyric this long is already wrong, and
 * a card that shows most of the words beats one that shows an error.
 */
const MAX_LYRIC_LENGTH = 10000;

function clamp(lyric) {
  if (typeof lyric !== 'string' || !lyric) return null;
  return lyric.length > MAX_LYRIC_LENGTH ? lyric.slice(0, MAX_LYRIC_LENGTH) : lyric;
}

/**
 * Fetches in progress, keyed source:externalId.
 *
 * Bounded by how many distinct tracks are being asked for at this instant, and
 * every entry is removed in a `finally` — a failed fetch clears just as a
 * successful one does, so a platform outage cannot leave a key behind that
 * would serve its rejection to everyone who follows.
 */
const inFlight = new Map();

/**
 * Lyrics for a pool track, from the database when they are there.
 *
 * `fetcher` is called only on a miss and only for its return value; a throw is
 * left to the caller. Both the words and the fact of having asked are written,
 * so a song the platform has none for is not asked about again — instrumentals
 * would otherwise generate all of the traffic caching is meant to remove.
 *
 * A write failure is swallowed: the caller already has the lyrics, and losing
 * the chance to store them is worth less than the request it would fail.
 *
 * @param {'QQ'|'NETEASE'|'LOCAL'} source
 * @param {string} externalId
 * @param {() => Promise<{lyric: string|null, translation: string|null}>} fetcher
 * @returns {Promise<{lyric: string|null, translation: string|null, cached: boolean}>}
 */
async function getOrFetch(source, externalId, fetcher) {
  const track = await prisma.importedTrack.findUnique({
    where: { source_externalId: { source, externalId: String(externalId) } },
    select: { id: true, lyric: true, lyricFetchedAt: true },
  });

  // Asked before, so the answer stands even when it was "this song has none".
  if (track?.lyricFetchedAt) {
    return { lyric: track.lyric, translation: null, cached: true };
  }

  // A miss that is already being fetched joins that fetch rather than starting
  // another. Without this the store does nothing in the case it exists for: a
  // freshly imported song, or the first minutes after a deploy, is a miss for
  // everybody at once, and every one of them would go to the platform. The
  // read and the write are separate awaits, so the row cannot serve as the
  // lock -- nothing is written until the first fetch returns.
  const key = `${source}:${externalId}`;
  const running = inFlight.get(key);
  if (running) return running;

  const attempt = (async () => fetchAndStore(track, fetcher))();
  inFlight.set(key, attempt);
  try {
    return await attempt;
  } finally {
    inFlight.delete(key);
  }
}

/** The miss path, split out so the in-flight map above can hold one promise. */
async function fetchAndStore(track, fetcher) {
  const fresh = await fetcher();

  if (track) {
    try {
      await prisma.importedTrack.update({
        where: { id: track.id },
        data: { lyric: clamp(fresh.lyric), lyricFetchedAt: new Date() },
      });
    } catch {
      /* Storing is an optimisation; the caller has what it asked for. */
    }
  }

  // Clamped here too, so the first caller and every later one are shown the
  // same words — otherwise an over-long lyric would read in full once and
  // truncated forever after, which looks like the page losing text.
  return { lyric: clamp(fresh.lyric), translation: fresh.translation || null, cached: false };
}

/**
 * Write lyrics for a pool track without reading first.
 *
 * For the warm-up script, which already knows the row is a miss and does not
 * need the extra query. Silent when the row is gone — a track deleted between
 * the scan and the write is not a failure worth stopping a long run for.
 */
async function store(source, externalId, lyric) {
  await prisma.importedTrack.updateMany({
    where: { source, externalId: String(externalId) },
    data: { lyric: clamp(lyric), lyricFetchedAt: new Date() },
  });
}

module.exports = { getOrFetch, store };
