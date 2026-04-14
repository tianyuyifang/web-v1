const prisma = require('../db/client');

/**
 * Detect the type of search query.
 * Returns 'pinyin_any' | 'full_pinyin' | 'chinese' | null
 *
 * 'pinyin_any' covers: initials (xqg), spaceless pinyin (xiaoqingge),
 * mixed (xqge), and typos — searched against both initials and concat columns.
 */
function detectQueryType(query) {
  if (!query) return null;

  // Contains CJK characters → Chinese fuzzy
  if (/[\u4e00-\u9fff]/.test(query)) return 'chinese';

  // ASCII with spaces → full pinyin (spaced)
  if (/\s/.test(query)) return 'full_pinyin';

  // All lowercase letters, no spaces → could be initials, concat pinyin, or typo
  if (/^[a-z]+$/.test(query)) return 'pinyin_any';

  // Fallback (mixed case, numbers, etc.)
  return 'full_pinyin';
}

/**
 * Search songs across title + artist using the appropriate strategy.
 * Returns raw Prisma results (songs with clips).
 */
async function searchSongs(query, cursor, limit, strict = false) {
  const type = detectQueryType(query);

  // No query — return all songs paginated
  if (!type) {
    const where = cursor ? { id: { gt: cursor } } : {};
    return prisma.song.findMany({
      where,
      orderBy: { id: 'asc' },
      take: limit + 1,
      include: { clips: { orderBy: { start: 'asc' } } },
    });
  }

  // Build raw SQL for search
  // Set threshold per query to ensure correctness after DB reconnects
  await prisma.$executeRawUnsafe('SET pg_trgm.similarity_threshold = 0.35');

  const params = [];
  let whereClause;

  let orderClause = 'ORDER BY s.id ASC';

  if (type === 'pinyin_any') {
    // Search initials (prefix), concat pinyin (substring), and trigram similarity
    params.push(query);             // $1 = raw query
    params.push(`${query}%`);       // $2 = prefix pattern

    if (strict) {
      // Strict: prefix-only on initials and concat pinyin (no substring, no trigram)
      params.push(`%|${query}%`);  // $3 = initials_all mid-variant prefix (e.g. %|xxtl%)
      whereClause = `(
        s.title_pinyin_initials LIKE $2
        OR sa.artist_pinyin_initials LIKE $2
        OR s.title_pinyin_initials_all LIKE $2
        OR s.title_pinyin_initials_all LIKE $3
        OR sa.artist_pinyin_initials_all LIKE $2
        OR sa.artist_pinyin_initials_all LIKE $3
        OR s.title_pinyin_concat ILIKE $2
        OR s.artist_pinyin_concat ILIKE $2
        OR sa.artist_pinyin_concat ILIKE $2
      )`;
      orderClause = `ORDER BY CASE
        WHEN s.title_pinyin_initials = $1 OR s.title_pinyin_concat ILIKE $1 THEN 0
        WHEN s.title_pinyin_initials LIKE $2 OR s.title_pinyin_concat ILIKE $2 THEN 1
        ELSE 2 END, s.title ASC`;
    } else {
      params.push(`%${query}%`);   // $3 = substring pattern
      params.push(`%|${query}%`);  // $4 = initials_all mid-variant prefix
      whereClause = `(
        s.title_pinyin_initials LIKE $2
        OR sa.artist_pinyin_initials LIKE $2
        OR s.title_pinyin_initials_all LIKE $2
        OR s.title_pinyin_initials_all LIKE $4
        OR sa.artist_pinyin_initials_all LIKE $2
        OR sa.artist_pinyin_initials_all LIKE $4
        OR s.title_pinyin_concat ILIKE $3
        OR s.artist_pinyin_concat ILIKE $3
        OR sa.artist_pinyin_concat ILIKE $3
        OR s.title_pinyin_all ILIKE $3
        OR s.artist_pinyin_all ILIKE $3
        OR sa.artist_pinyin_all ILIKE $3
        OR s.title_pinyin_concat % $1
        OR s.title_pinyin % $1
      )`;
    }
  } else if (type === 'full_pinyin') {
    // Spaced pinyin — search both spaced and concat columns + trigram fallback
    params.push(query);             // $1 = raw query

    if (strict) {
      params.push(`${query}%`);    // $2 = prefix pattern
      whereClause = `(
        s.title_pinyin ILIKE $2
        OR s.artist_pinyin ILIKE $2
        OR sa.artist_pinyin ILIKE $2
      )`;
      orderClause = `ORDER BY CASE
        WHEN s.title_pinyin ILIKE $1 THEN 0
        WHEN s.title_pinyin ILIKE $2 THEN 1
        ELSE 2 END, s.title ASC`;
    } else {
      params.push(`%${query}%`);   // $2 = substring pattern
      whereClause = `(
        s.title_pinyin ILIKE $2
        OR s.artist_pinyin ILIKE $2
        OR sa.artist_pinyin ILIKE $2
        OR s.title_pinyin_all ILIKE $2
        OR s.artist_pinyin_all ILIKE $2
        OR sa.artist_pinyin_all ILIKE $2
        OR s.title_pinyin % $1
        OR s.title_pinyin_concat % $1
      )`;
    }
  } else {
    // chinese — ILIKE on title/artist + trigram fallback
    params.push(query);             // $1 = raw query

    if (strict) {
      params.push(`${query}%`);    // $2 = prefix pattern
      params.push(`%${query}%`);   // $3 = substring pattern
      whereClause = `(
        s.title ILIKE $2
        OR s.title ILIKE $3
        OR sa.artist_name ILIKE $3
      )`;
      orderClause = `ORDER BY CASE
        WHEN s.title ILIKE $1 THEN 0
        WHEN s.title ILIKE $2 THEN 1
        WHEN s.title ILIKE $3 THEN 2
        ELSE 3 END, s.title ASC`;
    } else {
      params.push(`%${query}%`);   // $2 = substring pattern
      whereClause = `(
        s.title ILIKE $2
        OR sa.artist_name ILIKE $2
        OR s.title % $1
      )`;
    }
  }

  // Cursor condition
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = `AND s.id > $${params.length}`;
  }

  params.push(limit + 1);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT s.id, s.title FROM songs s
    LEFT JOIN song_artists sa ON sa.song_id = s.id
    WHERE ${whereClause}
    ${cursorClause}
    GROUP BY s.id, s.title
    ${orderClause}
    LIMIT ${limitParam}
  `;

  const matchedIds = await prisma.$queryRawUnsafe(sql, ...params);
  const ids = matchedIds.map((r) => r.id);

  if (ids.length === 0) return [];

  // Preserve the relevance order from the raw SQL
  const songs = await prisma.song.findMany({
    where: { id: { in: ids } },
    include: { clips: { orderBy: { start: 'asc' } } },
  });
  const idOrder = new Map(ids.map((id, i) => [id, i]));
  songs.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
  return songs;
}

/**
 * Search playlists visible to the user (own + shared + public).
 */
async function searchPlaylists(query, userId) {
  const type = detectQueryType(query);

  let nameFilter = {};
  if (type === 'pinyin_any') {
    nameFilter = {
      OR: [
        { namePinyinInitials: { startsWith: query } },
        { namePinyin: { contains: query, mode: 'insensitive' } },
        { namePinyinAll: { contains: query, mode: 'insensitive' } },
        { user: { username: { contains: query, mode: 'insensitive' } } },
      ],
    };
  } else if (type === 'full_pinyin') {
    nameFilter = {
      OR: [
        { namePinyin: { contains: query, mode: 'insensitive' } },
        { namePinyinAll: { contains: query, mode: 'insensitive' } },
        { user: { username: { contains: query, mode: 'insensitive' } } },
      ],
    };
  } else if (type === 'chinese') {
    nameFilter = {
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { user: { username: { contains: query, mode: 'insensitive' } } },
      ],
    };
  }

  const results = await prisma.playlist.findMany({
    where: {
      AND: [
        {
          OR: [
            { userId },
            { shares: { some: { userId } } },
            { copyPermissions: { some: { userId } } },
            { isPublic: true },
          ],
        },
        ...(type ? [nameFilter] : []),
      ],
    },
    include: {
      _count: { select: { playlistClips: true } },
      user: { select: { username: true } },
      shares: { where: { userId }, select: { id: true } },
      copyPermissions: { where: { userId }, select: { id: true } },
    },
  });

  // Sort: emojis first, then alphabetical by pinyin (stripped of leading emojis/symbols)
  const emojiRegex = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
  const stripPrefix = (s) => s.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
  results.sort((a, b) => {
    const aEmoji = emojiRegex.test(a.name);
    const bEmoji = emojiRegex.test(b.name);
    if (aEmoji !== bEmoji) return aEmoji ? -1 : 1;
    const aKey = stripPrefix(a.namePinyin || a.name);
    const bKey = stripPrefix(b.namePinyin || b.name);
    return aKey.localeCompare(bKey);
  });

  return results;
}

/**
 * Search clips within a specific playlist by song title/artist.
 */
async function searchClipsInPlaylist(playlistId, query) {
  const type = detectQueryType(query);

  let songFilter = {};
  if (type === 'pinyin_any') {
    songFilter = {
      clip: {
        song: {
          OR: [
            { titlePinyinInitials: { startsWith: query } },
            { titlePinyinInitialsAll: { contains: query } },
            { titlePinyinConcat: { contains: query, mode: 'insensitive' } },
            { artistPinyinConcat: { contains: query, mode: 'insensitive' } },
            { titlePinyinAll: { contains: query, mode: 'insensitive' } },
            { artistPinyinAll: { contains: query, mode: 'insensitive' } },
          ],
        },
      },
    };
  } else if (type === 'full_pinyin') {
    songFilter = {
      clip: {
        song: {
          OR: [
            { titlePinyin: { contains: query, mode: 'insensitive' } },
            { artistPinyin: { contains: query, mode: 'insensitive' } },
            { titlePinyinAll: { contains: query, mode: 'insensitive' } },
            { artistPinyinAll: { contains: query, mode: 'insensitive' } },
          ],
        },
      },
    };
  } else if (type === 'chinese') {
    songFilter = {
      clip: {
        song: {
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { artist: { contains: query, mode: 'insensitive' } },
          ],
        },
      },
    };
  }

  return prisma.playlistClip.findMany({
    where: {
      playlistId,
      ...songFilter,
    },
    orderBy: { position: 'asc' },
    include: {
      clip: {
        include: {
          song: {
            select: {
              id: true,
              title: true,
              artist: true,
              duration: true,
              titlePinyin: true,
              titlePinyinInitials: true,
              titlePinyinConcat: true,
              artistPinyinConcat: true,
            },
          },
        },
      },
    },
  });
}

module.exports = {
  detectQueryType,
  searchSongs,
  searchPlaylists,
  searchClipsInPlaylist,
};
