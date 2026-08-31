/**
 * The "已标记" view of 唱卡: the songs a singer has put a note or a colour on,
 * so they can look back over what they marked rather than search the whole
 * library for it.
 *
 * Deliberately narrow. This tab is about notes and colours only — a saved key
 * or tempo does not put a song here, because those are a playback convenience
 * the singer set in passing, not a mark they made to find the song again. The
 * filters follow the same rule: 有备注 and each colour, nothing about pitch or
 * speed.
 *
 * song_prefs is the driving table here, the mirror of songLibraryService which
 * drives from the mappings. A pref carries no title of its own — it is keyed on
 * (source, externalId) with no foreign key, because the three id spaces have
 * nothing in common — so the platform names are joined in from song_mappings
 * where a confirmed mapping exists. A marked song whose mapping was since
 * removed still shows, by its ids, rather than vanishing silently.
 *
 * Nothing here talks to QQ or NetEase. Every field is one we already hold, so
 * browsing costs one indexed query against the singer's own rows — no outbound
 * request, no credential, nothing on the server's shared address.
 */
const prisma = require('../db/client');
const { titleKey } = require('./songKeyService');

const PAGE_SIZE = 40;
const MAX_TAKE = 100;

// The sentinel row that holds a singer's global default key/tempo. It is not a
// marked song and must never appear in this list.
const DEFAULT_SOURCE = 'LOCAL';
const DEFAULT_EXTERNAL_ID = '__default__';

/**
 * Make a search term safe for a LIKE, the same two hazards songLibraryService
 * guards against: a null byte is a hard Postgres error (22021), and %/_ are
 * LIKE wildcards Prisma's raw parameters do not escape. The backslash goes
 * first so it does not escape the escapes added after it.
 */
function cleanLike(query) {
  return String(query == null ? '' : query)
    // eslint-disable-next-line no-control-regex
    .replace(/\x00/g, '')
    .trim()
    .replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * A colour filter value, validated to a hex colour before it reaches SQL.
 *
 * The colours are stored pipe-separated in one column, so "has this colour" is
 * a substring test — which is exactly why the value has to be pinned to a
 * strict shape first: an unchecked substring would let a caller probe the
 * column with arbitrary LIKE patterns. A real palette entry is #rgb or #rrggbb.
 */
function cleanColor(color) {
  const c = String(color == null ? '' : color).trim();
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c) ? c : null;
}

/**
 * A page of the singer's marked songs.
 *
 * @param {string} userId
 * @param {object} opts
 * @param {string} opts.query   free text over both name sides; optional
 * @param {boolean} opts.hasNote   only songs carrying a note
 * @param {string[]} opts.colors   only songs carrying every one of these colours
 * @param {number} opts.offset   rows to skip, for paging
 * @param {number} opts.take
 */
async function search(userId, {
  query = '', hasNote = false, colors = [], offset = 0, take = PAGE_SIZE,
} = {}) {
  const limit = Math.min(Math.max(Number(take) || PAGE_SIZE, 1), MAX_TAKE);
  const skip = Math.max(Number(offset) || 0, 0);
  const q = cleanLike(query);
  const safeColors = (Array.isArray(colors) ? colors : [])
    .map(cleanColor).filter(Boolean).slice(0, 8);

  // Built as a parameterised list so every value is bound, never interpolated.
  const params = [userId, DEFAULT_SOURCE, DEFAULT_EXTERNAL_ID];
  const conds = [
    'sp.user_id = $1::uuid',
    // A marked song is one with a note or at least one colour. The sentinel
    // default row has neither and is excluded by that alone, but it is named
    // explicitly too so a stray note on it could never leak in.
    "(NULLIF(TRIM(sp.note), '') IS NOT NULL OR NULLIF(TRIM(sp.color_tag), '') IS NOT NULL)",
    'NOT (sp.source = $2::"SongSource" AND sp.external_id = $3)',
  ];

  if (hasNote) {
    conds.push("NULLIF(TRIM(sp.note), '') IS NOT NULL");
  }

  for (const color of safeColors) {
    params.push(`%${color.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    conds.push(`sp.color_tag LIKE $${params.length}`);
  }

  if (q) {
    // Matched against both name sides, game and platform, like the library —
    // 24% of confirmed rows disagree on a name, so one side alone loses a
    // quarter of them depending on which the singer remembers. The normalised
    // key catches width/case differences they will not type exactly.
    params.push(`%${q}%`);
    const like = `$${params.length}`;
    params.push(`%${cleanLike(titleKey(query))}%`);
    const keyLike = `$${params.length}`;
    conds.push(`(
      m.raw_title ILIKE ${like} OR m.raw_artist ILIKE ${like}
      OR m.platform_title ILIKE ${like} OR m.platform_artist ILIKE ${like}
      OR m.title_key LIKE ${keyLike}
    )`);
  }

  // One extra row answers "is there a next page" without a second count query.
  params.push(limit + 1);
  const takeParam = `$${params.length}`;
  params.push(skip);
  const skipParam = `$${params.length}`;

  const sql = `
    SELECT sp.source, sp.external_id, sp.note, sp.color_tag, sp.pitch, sp.speed,
           m.id            AS mapping_id,
           m.raw_title, m.raw_artist,
           m.platform_title, m.platform_artist, m.duration_sec
      FROM song_prefs sp
      LEFT JOIN song_mappings m
        ON m.source = sp.source
       AND m.external_id = sp.external_id
       AND m.approved = TRUE
     WHERE ${conds.join('\n       AND ')}
     ORDER BY sp.updated_at DESC, sp.external_id ASC
     LIMIT ${takeParam} OFFSET ${skipParam}`;

  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    rows: page.map((r) => ({
      id: r.mapping_id || `${r.source}:${r.external_id}`,
      source: r.source,
      externalId: r.external_id,
      // The game side is what the singer went looking for; fall back to the
      // ids when the mapping is gone, so a marked song never renders blank.
      title: r.raw_title || null,
      artist: r.raw_artist || null,
      platformTitle: r.platform_title || null,
      platformArtist: r.platform_artist || null,
      durationSec: r.duration_sec != null ? Number(r.duration_sec) : null,
      // Only the two marks this tab is about. Pitch and speed are held but not
      // sent: they belong to playback, not to this review of what was marked.
      prefs: { note: r.note || null, colorTag: r.color_tag || null },
    })),
    nextOffset: hasMore ? skip + limit : null,
  };
}

module.exports = { search };
