/**
 * 歌P singer library: which songs the game has offered under which singer, and
 * how each of those titles is written on the site.
 *
 * Fed by the capture client (v28+), which reads the game's assigned singer in
 * the same scan as each 歌P title; edited on the review page (「歌手」tab).
 *
 * The one thing it does for capture: a 歌P title that matched nothing in the
 * destination list gets a second try through the titles an editor attached to
 * it here (`siteTitlesFor`). Whatever that finds is offered as 待确认 only --
 * the callers never let it like on its own.
 */
const prisma = require('../db/client');
const { matchTitle } = require('./captureMatchService');
const { NotFoundError, ValidationError } = require('../utils/errors');

const MAX_SINGER = 64;
const MAX_TITLE = 120;

/** The game's 《title》 as stored: the marks off the two ends, nothing else touched. */
function cleanTitle(raw) {
  let t = String(raw == null ? '' : raw).trim();
  if (t.startsWith('《')) t = t.slice(1);
  if (t.endsWith('》')) t = t.slice(0, -1);
  return t.trim();
}

function cleanSinger(raw) {
  return String(raw == null ? '' : raw).trim();
}

/**
 * Pairs already written by this process, so a title re-read every sweep does
 * not cost a database write each time. Bounded; a restart only costs one
 * skipped insert per pair.
 */
const known = new Set();
const KNOWN_MAX = 5000;

/**
 * Record one pair seen in play. Fire-and-forget: never throws, never waits
 * on the caller's path.
 */
function note(singerRaw, titleRaw) {
  const singer = cleanSinger(singerRaw);
  const title = cleanTitle(titleRaw);
  if (!singer || !title || singer.length > MAX_SINGER || title.length > MAX_TITLE) return;
  const key = `${singer}\u0000${title}`;
  if (known.has(key)) return;
  if (known.size >= KNOWN_MAX) known.clear();
  known.add(key);
  // try as well as .catch: in the window of a deploy between `git pull` and
  // `prisma generate`, the model is missing from the client and the call
  // throws before any promise exists -- which would 500 the capture itself.
  try {
    prisma.gepSingerSong.createMany({
      data: [{ singer, title, source: 'game' }],
      skipDuplicates: true,
    }).catch((err) => {
      known.delete(key);
      console.warn('[gep-singer] record failed:', err.message);
    });
  } catch (err) {
    known.delete(key);
    console.warn('[gep-singer] record failed:', err.message);
  }
}

/**
 * The site titles an editor attached to this game title under this singer.
 * Empty on any failure: this only ever adds a suggestion, so failing quiet
 * leaves capture exactly as it was without it.
 */
async function siteTitlesFor(singerRaw, titleRaw) {
  const singer = cleanSinger(singerRaw);
  const title = cleanTitle(titleRaw);
  if (!singer || !title) return [];
  try {
    const row = await prisma.gepSingerSong.findUnique({
      where: { singer_title: { singer, title } },
      select: { aliases: { select: { siteTitle: true } } },
    });
    return row ? row.aliases.map((a) => a.siteTitle) : [];
  } catch (err) {
    console.warn('[gep-singer] alias lookup failed:', err.message);
    return [];
  }
}

/** Is `singer` named in a credit like "周杰伦/费玉清" or "周杰伦_费玉清"? */
function creditsSinger(artist, singer) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const want = norm(singer);
  if (!want) return false;
  return String(artist || '').split(/[/_、,，&]+/).some((part) => norm(part) === want);
}

/**
 * Songs in `songs` ({id, title, artist}) whose title is exactly one of the
 * site titles attached to this game title.
 *
 * Exact only -- the attached title is already the editor's statement of what
 * the song is called, so nothing looser is needed or wanted. When the singer
 * is credited on some of them, only those are offered. Each comes back as kind
 * 'alias', which nothing treats as safe to like unasked (only 'exact' is).
 */
function matchSiteTitles({ singer, gameTitle, siteTitles, songs }) {
  const found = new Map();
  for (const st of siteTitles || []) {
    for (const c of matchTitle(st, songs).candidates) {
      if (c.kind !== 'exact' || found.has(String(c.songId))) continue;
      found.set(String(c.songId), {
        songId: c.songId,
        title: c.title,
        artist: c.artist,
        kind: 'alias',
        note: `歌手库：${cleanSinger(singer)} 的《${cleanTitle(gameTitle)}》对应「${st}」`,
      });
    }
  }
  const list = [...found.values()];
  const credited = list.filter((c) => creditsSinger(c.artist, singer));
  return credited.length ? credited : list;
}

// --- review page ------------------------------------------------------------

/**
 * Singers with how many songs each. A search picks which singers (by their
 * name or any of their titles); the count is always the singer's total, so
 * it means the same thing with or without one.
 */
async function listSingers({ query } = {}) {
  const q = String(query || '').trim();
  let where = {};
  if (q) {
    const hits = await prisma.gepSingerSong.findMany({
      where: { OR: [{ singer: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }] },
      distinct: ['singer'],
      select: { singer: true },
      take: 500,
    });
    where = { singer: { in: hits.map((h) => h.singer) } };
  }
  const rows = await prisma.gepSingerSong.groupBy({
    by: ['singer'],
    where,
    _count: { _all: true },
    orderBy: { singer: 'asc' },
  });
  return { singers: rows.map((r) => ({ singer: r.singer, songs: r._count._all })) };
}

/** One singer's songs, each with its site titles. */
async function listSongs(singerRaw) {
  const singer = cleanSinger(singerRaw);
  if (!singer) throw new ValidationError({ singer: ['缺少歌手'] });
  const rows = await prisma.gepSingerSong.findMany({
    where: { singer },
    orderBy: { title: 'asc' },
    include: { aliases: { orderBy: { createdAt: 'asc' } } },
  });
  return {
    singer,
    songs: rows.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      createdAt: r.createdAt,
      aliases: r.aliases.map((a) => ({ id: a.id, siteTitle: a.siteTitle })),
    })),
  };
}

async function addSong(singerRaw, titleRaw) {
  const singer = cleanSinger(singerRaw);
  const title = cleanTitle(titleRaw);
  if (!singer || singer.length > MAX_SINGER) throw new ValidationError({ singer: ['歌手不能为空，最多 64 字'] });
  if (!title || title.length > MAX_TITLE) throw new ValidationError({ title: ['歌名不能为空，最多 120 字'] });
  const where = { singer_title: { singer, title } };
  const row = await prisma.gepSingerSong.upsert({
    where, update: {}, create: { singer, title, source: 'manual' }, include: { aliases: true },
  }).catch(async (err) => {
    if (err.code !== 'P2002') throw err;
    return prisma.gepSingerSong.findUnique({ where, include: { aliases: true } });
  });
  return { id: row.id, singer: row.singer, title: row.title, source: row.source, aliases: row.aliases.map((a) => ({ id: a.id, siteTitle: a.siteTitle })) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function deleteSong(id) {
  if (!UUID_RE.test(String(id))) throw new NotFoundError('Song');
  const { count } = await prisma.gepSingerSong.deleteMany({ where: { id } });
  if (!count) throw new NotFoundError('Song');
  // So a pair deleted by hand is recorded again when play shows it again,
  // rather than being skipped as already written.
  known.clear();
  return { deleted: true };
}

async function addAlias(singerSongId, siteTitleRaw) {
  if (!UUID_RE.test(String(singerSongId))) throw new NotFoundError('Song');
  const siteTitle = String(siteTitleRaw == null ? '' : siteTitleRaw).trim();
  if (!siteTitle || siteTitle.length > MAX_TITLE) throw new ValidationError({ siteTitle: ['网站歌名不能为空，最多 120 字'] });
  const song = await prisma.gepSingerSong.findUnique({ where: { id: singerSongId }, select: { id: true } });
  if (!song) throw new NotFoundError('Song');
  const where = { singerSongId_siteTitle: { singerSongId, siteTitle } };
  const row = await prisma.gepSongAlias.upsert({ where, update: {}, create: { singerSongId, siteTitle } })
    .catch(async (err) => {
      if (err.code !== 'P2002') throw err;
      return prisma.gepSongAlias.findUnique({ where });
    });
  return { id: row.id, siteTitle: row.siteTitle };
}

async function deleteAlias(id) {
  if (!UUID_RE.test(String(id))) throw new NotFoundError('Alias');
  const { count } = await prisma.gepSongAlias.deleteMany({ where: { id } });
  if (!count) throw new NotFoundError('Alias');
  return { deleted: true };
}

module.exports = {
  note, siteTitlesFor, matchSiteTitles, creditsSinger, cleanTitle, cleanSinger,
  listSingers, listSongs, addSong, deleteSong, addAlias, deleteAlias,
};
