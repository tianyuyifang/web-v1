/**
 * The searchable side of 唱卡: every confirmed song, so a singer can put a
 * colour or a note on one without waiting to meet it in a game.
 *
 * Marking used to be possible only while a card was on screen, which meant the
 * thought "this one is too high for me" arrived at the one moment there was no
 * time to act on it. This reads the same rows the game matches against, so a
 * preference set here is already in place when the song turns up.
 *
 * Confirmed only. An unapproved mapping may still be repointed at a different
 * recording, and a preference attached to it would silently come to describe a
 * song the singer never chose.
 *
 * Nothing here talks to QQ or NetEase. Every field shown is one we already
 * store, so browsing the library — however long the singer browses — costs no
 * outbound request, spends no credential, and puts nothing on the server's
 * shared address.
 */
const prisma = require('../db/client');
const songPrefs = require('./songPrefService');
const { titleKey } = require('./songKeyService');

const PAGE_SIZE = 40;
const MAX_TAKE = 100;

/**
 * The search term, made safe to hand to Postgres.
 *
 * Two hazards, both found by testing rather than by reading the code:
 *
 *   A null byte is rejected by Postgres outright (22021, "invalid byte
 *   sequence for encoding UTF8"), which surfaces as a 500 from a search box --
 *   one pasted character takes the tab down.
 *
 *   `%` and `_` are LIKE wildcards and Prisma's `contains` does not escape
 *   them. Typing a single `_` matched every confirmed song instead of none,
 *   because `contains: '_'` means "any one character". Escaping is what makes
 *   the box search for the character the singer actually typed.
 *
 * The backslash is Postgres's default LIKE escape, and it has to be escaped
 * first -- doing it later would escape the escapes added before it.
 */
function clean(query) {
  return String(query == null ? '' : query)
    // eslint-disable-next-line no-control-regex
    .replace(/\x00/g, '')
    .trim()
    .replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Confirmed mappings matching a search term.
 *
 * The term is matched against BOTH sides — what the game calls the song and
 * what the platform calls it. Measured on live data, 24% of confirmed rows
 * disagree on title or artist (郁可唯 in the game, 刘亦玫 on QQ), so searching
 * one side alone loses about a quarter of the library depending on which name
 * the singer happens to remember.
 *
 * @param {string} userId whose preferences to attach
 * @param {object} opts
 * @param {string} opts.query free text; empty returns nothing
 * @param {string|null} opts.cursor id of the last row of the previous page
 */
async function search(userId, { query = '', cursor = null, take = PAGE_SIZE } = {}) {
  const q = clean(query);
  const limit = Math.min(Math.max(Number(take) || PAGE_SIZE, 1), MAX_TAKE);

  // "Show me everything" is not a real question against 1,900 rows, and an
  // empty box should not pull the whole table over a phone connection.
  if (!q) return { rows: [], nextCursor: null };

  const where = {
    approved: true,
    OR: [
      // Game side, raw and normalised. The normalised key is what makes a
      // search work across width and case differences the singer will not
      // think about while typing.
      { rawTitle: { contains: q, mode: 'insensitive' } },
      { rawArtist: { contains: q, mode: 'insensitive' } },
      { titleKey: { contains: titleKey(q) } },
      // Platform side. Display-only columns elsewhere, but here they are half
      // of what the singer might remember.
      { platformTitle: { contains: q, mode: 'insensitive' } },
      { platformArtist: { contains: q, mode: 'insensitive' } },
    ],
  };

  const rows = await prisma.songMapping.findMany({
    where,
    orderBy: [{ rawTitle: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      rawTitle: true,
      rawArtist: true,
      platformTitle: true,
      platformArtist: true,
      source: true,
      externalId: true,
      durationSec: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  // One query for the page's preferences, the same call the live cards use.
  const prefs = await songPrefs.getMany(
    userId,
    page.map((r) => ({ source: r.source, externalId: r.externalId })),
  );

  return {
    rows: page.map((r) => ({
      id: r.id,
      // What the game shows — what the singer is looking for.
      title: r.rawTitle,
      artist: r.rawArtist,
      // What the platform actually plays. Sent even when identical, so the
      // page decides whether repeating it is worth the line rather than
      // having that decision baked in here.
      platformTitle: r.platformTitle || null,
      platformArtist: r.platformArtist || null,
      source: r.source,
      externalId: r.externalId,
      durationSec: r.durationSec,
      prefs: prefs.get(`${r.source}:${r.externalId}`) || null,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

module.exports = { search };
