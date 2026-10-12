/**
 * 歌P singer library: which songs the game has offered under which singer, and
 * how each of those titles is written on the site.
 *
 * Fed by the capture client (v28+), which reads the game's assigned singer in
 * the same scan as each 歌P title; edited on the review page (「歌手」tab).
 *
 * What it does for capture: a 歌P title that matched nothing in the
 * destination list gets a second try through the titles an editor attached to
 * it here (`siteTitlesFor`). What that finds is liked on its own only when it
 * is one song credited to the game's singer (`credited`, 2026-10-11 方案 C);
 * anything else is offered as 待确认.
 *
 * And it marks a title 待处理 (`noteReview`) when a 歌P capture of it found no
 * perfect match and no 网站歌名 helped -- the case an editor can fix here.
 */
const prisma = require('../db/client');
const { matchTitle } = require('./captureMatchService');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { toPinyin } = require('../utils/pinyin');

/**
 * Alphabetical as a reader means it: Chinese by pinyin, mixed in with Latin.
 * Spaces out: the pinyin comes back split per character ("zhou jie lun"),
 * and a space sorts before every letter.
 */
const sortKey = (s) => String(toPinyin(String(s || '')) || '').replace(/\s+/g, '').toLowerCase();
/** Sorted copy of `rows` by the pinyin of get(row); each key worked out once. */
function sortByPinyin(rows, get) {
  return rows
    .map((r) => ({ r, k: sortKey(get(r)), raw: String(get(r)) }))
    .sort((a, b) => (a.k === b.k ? a.raw.localeCompare(b.raw) : a.k.localeCompare(b.k)))
    .map((x) => x.r);
}

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
 * 'alias' with `credited` saying whether the game's singer is on it: a caller
 * may like it on its own only when the list it acts on is that one credited
 * song (the auto: true it then sets on the candidate); otherwise it waits in
 * 待确认.
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
        credited: creditsSinger(c.artist, singer),
        note: `歌手库：${cleanSinger(singer)} 的《${cleanTitle(gameTitle)}》对应「${st}」`,
      });
    }
  }
  const list = [...found.values()];
  const credited = list.filter((c) => c.credited);
  return credited.length ? credited : list;
}

/**
 * 方案 C: what a 网站歌名 found may be liked without asking only when it is
 * exactly one song and the game's singer is credited on it.
 */
function aliasAutoOk(actionable) {
  return Array.isArray(actionable) && actionable.length === 1
    && actionable[0].kind === 'alias' && actionable[0].credited === true;
}

/**
 * Mark this singer's title 待处理: a 歌P capture of it found no perfect match
 * and no 网站歌名 found it. Fire-and-forget, like note(): never throws, never
 * waits on the capture. The row is made if play has not recorded it yet.
 */
function noteReview(singerRaw, titleRaw, { evenWithAlias = false, seenAliases = [] } = {}) {
  const singer = cleanSinger(singerRaw);
  const title = cleanTitle(titleRaw);
  if (!singer || !title || singer.length > MAX_SINGER || title.length > MAX_TITLE) return;
  const now = new Date();
  // Only a title without a 网站歌名: one added while this capture was being
  // matched has already answered it, and must not be marked over -- unless
  // the caller found that its 网站歌名 lead to nothing on the site
  // (evenWithAlias): those are wrong, and are what 待处理 is for. Even then
  // only over the ones it read (seenAliases): a 网站歌名 added since may well
  // be the right one.
  const mark = () => prisma.gepSingerSong.updateMany({
    where: evenWithAlias
      ? { singer, title, aliases: { every: { siteTitle: { in: seenAliases.map(String) } } } }
      : { singer, title, aliases: { none: {} } },
    data: { needsReviewAt: now },
  });
  try {
    (async () => {
      const { count } = await mark();
      if (count) return;
      // No row to mark (or it has a 网站歌名): make one only if none exists.
      try {
        await prisma.gepSingerSong.create({ data: { singer, title, source: 'game', needsReviewAt: now } });
      } catch (err) {
        // There is a row -- with a 网站歌名, or made by note() just now.
        if (err.code !== 'P2002') throw err;
        await mark();
      }
    })().catch((err) => console.warn('[gep-singer] review mark failed:', err.message));
  } catch (err) {
    console.warn('[gep-singer] review mark failed:', err.message);
  }
}

/**
 * This title's 网站歌名 under this singer, and whether any of them finds a song
 * in the site catalogue. `found` false with `hasAlias` true: the 网站歌名 is
 * there but wrong (nothing on the site is called that).
 */
async function aliasOnSite(singerRaw, titleRaw) {
  const siteTitles = await siteTitlesFor(singerRaw, titleRaw);
  if (!siteTitles.length) return { hasAlias: false, found: false, siteTitles };
  // Late: captureService requires this module.
  const { fetchCandidateSongs } = require('./captureService');
  const pool = [];
  for (const st of siteTitles) pool.push(...await fetchCandidateSongs(st));
  const found = matchSiteTitles({ singer: singerRaw, gameTitle: titleRaw, siteTitles, songs: pool }).length > 0;
  return { hasAlias: true, found, siteTitles };
}

/**
 * Whether the site catalogue holds a song called exactly this. One scan of
 * the songs table (~240ms measured 2026-10-11), and 歌P titles repeat all day,
 * so the answer is kept a while: a song imported meanwhile only delays a
 * mark's judgement, it never causes a wrong like.
 */
const SITE_EXACT_TTL_MS = 6 * 60 * 60 * 1000;
const siteExactCache = new Map(); // title -> { exact, at }
async function siteHasExact(title) {
  const hit = siteExactCache.get(title);
  if (hit && Date.now() - hit.at < SITE_EXACT_TTL_MS) return hit.exact;
  const { fetchCandidateSongs } = require('./captureService');
  const text = `《${title}》`;
  const exact = matchTitle(text, await fetchCandidateSongs(text)).candidates.some((c) => c.kind === 'exact');
  if (siteExactCache.size >= 5000) siteExactCache.clear();
  siteExactCache.set(title, { exact, at: Date.now() });
  return exact;
}

/**
 * 待处理 judged against the site catalogue alone (QQ打标's captures: what is
 * in someone's QQ list is unknown to us and nothing an editor can act on).
 * Marked when the site has no song called exactly this and no 网站歌名 of it
 * finds one.
 *
 * Fire-and-forget, never on the capture's path, and one at a time: each check
 * scans the songs table, and a screen of titles (or a rematch of hundreds)
 * arriving at once must not take the database's few connections from the
 * pages. Past REVIEW_QUEUE_MAX waiting, new ones are dropped -- a mark is
 * advice, and the next capture of the title asks again. A title already
 * marked needs no check.
 */
const REVIEW_QUEUE_MAX = 300;
let reviewChain = Promise.resolve();
let reviewWaiting = 0;
function reviewAgainstSite(singerRaw, titleRaw) {
  const singer = cleanSinger(singerRaw);
  const title = cleanTitle(titleRaw);
  if (!singer || !title) return;
  if (reviewWaiting >= REVIEW_QUEUE_MAX) return;
  reviewWaiting += 1;
  reviewChain = reviewChain.then(async () => {
    try {
      const row = await prisma.gepSingerSong.findUnique({
        where: { singer_title: { singer, title } }, select: { needsReviewAt: true },
      });
      if (row && row.needsReviewAt) return;
      if (await siteHasExact(title)) return;
      const a = await aliasOnSite(singer, title);
      if (a.found) return;
      noteReview(singer, title, { evenWithAlias: a.hasAlias, seenAliases: a.siteTitles });
    } catch (err) {
      console.warn('[gep-singer] review check failed:', err.message);
    } finally {
      reviewWaiting -= 1;
    }
  });
}

// --- review page ------------------------------------------------------------

/**
 * Singers with how many songs each. A search picks which singers (by their
 * name or any of their titles); the count is always the singer's total, so
 * it means the same thing with or without one.
 */
async function listSingers({ query, reviewOnly = false } = {}) {
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
  const [rows, flagged] = await Promise.all([
    prisma.gepSingerSong.groupBy({ by: ['singer'], where, _count: { _all: true } }),
    prisma.gepSingerSong.groupBy({
      by: ['singer'], where: { ...where, needsReviewAt: { not: null } }, _count: { _all: true },
    }),
  ]);
  const review = new Map(flagged.map((r) => [r.singer, r._count._all]));
  const singers = sortByPinyin(rows
    .map((r) => ({ singer: r.singer, songs: r._count._all, review: review.get(r.singer) || 0 }))
    .filter((r) => !reviewOnly || r.review > 0), (r) => r.singer);
  return { singers };
}

/** One singer's songs, each with its site titles. */
async function listSongs(singerRaw) {
  const singer = cleanSinger(singerRaw);
  if (!singer) throw new ValidationError({ singer: ['缺少歌手'] });
  const rows = sortByPinyin(await prisma.gepSingerSong.findMany({
    where: { singer },
    include: { aliases: { orderBy: { createdAt: 'asc' } } },
  }), (r) => r.title);
  return {
    singer,
    songs: rows.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      createdAt: r.createdAt,
      needsReviewAt: r.needsReviewAt,
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
  return { id: row.id, singer: row.singer, title: row.title, source: row.source, needsReviewAt: row.needsReviewAt, aliases: row.aliases.map((a) => ({ id: a.id, siteTitle: a.siteTitle })) };
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
  // A 网站歌名 is what 待处理 asked for (marked again only if it turns out to
  // find nothing on the site). Never fails the add: the 网站歌名 is
  // what matters, and the mark only steers the review list.
  await prisma.gepSingerSong.update({ where: { id: singerSongId }, data: { needsReviewAt: null } })
    .catch((err) => console.warn('[gep-singer] review clear failed:', err.message));
  return { id: row.id, siteTitle: row.siteTitle };
}

/** 已处理: an editor looked and there is nothing to add. */
async function clearReview(id) {
  if (!UUID_RE.test(String(id))) throw new NotFoundError('Song');
  const { count } = await prisma.gepSingerSong.updateMany({ where: { id }, data: { needsReviewAt: null } });
  if (!count) throw new NotFoundError('Song');
  return { ok: true };
}

async function deleteAlias(id) {
  if (!UUID_RE.test(String(id))) throw new NotFoundError('Alias');
  const { count } = await prisma.gepSongAlias.deleteMany({ where: { id } });
  if (!count) throw new NotFoundError('Alias');
  return { deleted: true };
}

module.exports = {
  note, siteTitlesFor, matchSiteTitles, creditsSinger, cleanTitle, cleanSinger,
  aliasAutoOk, noteReview, aliasOnSite, reviewAgainstSite,
  listSingers, listSongs, addSong, deleteSong, addAlias, deleteAlias, clearReview,
};
