/**
 * The searchable side of 唱卡: every confirmed song, so a singer can set a key,
 * a tempo, a colour or a note without waiting to meet the song in a game.
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
 * @param {boolean} opts.mine only rows this user has already marked
 * @param {string|null} opts.cursor id of the last row of the previous page
 */
async function search(userId, { query = '', mine = false, cursor = null, take = PAGE_SIZE } = {}) {
  const q = String(query || '').trim();
  const limit = Math.min(Math.max(Number(take) || PAGE_SIZE, 1), MAX_TAKE);

  // "Show me everything" is not a real question against 1,900 rows, and an
  // empty box should not pull the whole table over a phone connection. The
  // exception is the marked-only view, where the whole point is to see the
  // list without remembering what is on it.
  if (!q && !mine) return { rows: [], nextCursor: null };

  const where = { approved: true };

  if (q) {
    where.OR = [
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
    ];
  }

  // Narrowing to marked rows means intersecting two tables that have no
  // relation between them: preferences are keyed by (source, externalId), not
  // by mapping id. Read the user's keys first and constrain on those, rather
  // than reading every mapping and filtering in JS.
  if (mine) {
    const marked = await prisma.songPref.findMany({
      where: { userId },
      select: { source: true, externalId: true },
      // Bounded so a user with thousands of marks cannot build an unbounded
      // OR. Well past any real number of songs one person marks.
      take: 2000,
    });
    // Excludes the global-default sentinel row, which is a stored key/tempo
    // for the singer rather than a song, and would otherwise show up in the
    // library as a track called __default__.
    const pairs = marked.filter((m) => !(
      m.source === songPrefs.DEFAULT_SOURCE && m.externalId === songPrefs.DEFAULT_EXTERNAL_ID
    ));
    if (!pairs.length) return { rows: [], nextCursor: null };
    where.AND = [{
      OR: pairs.map((m) => ({ source: m.source, externalId: m.externalId })),
    }];
  }

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
