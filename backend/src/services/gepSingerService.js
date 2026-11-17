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
const { matchTitle, compareTitles, normTitle } = require('./captureMatchService');
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
 * Pairs already written by this process today (Beijing day), so a title
 * re-read every sweep costs at most one database write a day -- which is all
 * 最近出现 needs. Bounded; a restart only costs one more write per pair.
 */
const known = new Map(); // key -> the day it was last written
const KNOWN_MAX = 5000;

/** The Beijing calendar day: 最近出现 is kept to the day, the day as the users live it. */
const beijingDay = (d = new Date()) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * Record one pair seen in play, and that it was seen today. Fire-and-forget:
 * never throws, never waits on the caller's path.
 */
function note(singerRaw, titleRaw) {
  const singer = cleanSinger(singerRaw);
  const title = cleanTitle(titleRaw);
  if (!singer || !title || singer.length > MAX_SINGER || title.length > MAX_TITLE) return;
  const key = `${singer}\u0000${title}`;
  const now = new Date();
  const day = beijingDay(now);
  if (known.get(key) === day) return;
  if (known.size >= KNOWN_MAX) known.clear();
  known.set(key, day);
  const failed = (err) => {
    if (known.get(key) === day) known.delete(key);
    console.warn('[gep-singer] record failed:', err.message);
  };
  const touch = () => prisma.gepSingerSong.updateMany({ where: { singer, title }, data: { lastSeenAt: now } });
  // try as well as .catch: in the window of a deploy between `git pull` and
  // `prisma generate`, the model is missing from the client and the call
  // throws before any promise exists -- which would 500 the capture itself.
  try {
    (async () => {
      if ((await touch()).count) return;
      const { count } = await prisma.gepSingerSong.createMany({
        data: [{ singer, title, source: 'game', lastSeenAt: now }],
        skipDuplicates: true,
      });
      // Made meanwhile (noteReview, or an editor): it is there now; mark it seen.
      if (!count) await touch();
    })().catch(failed);
  } catch (err) {
    failed(err);
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
  //
  // review_since keeps when this 待处理 began (重新解析 compares uploads with
  // it); needs_review_at moves on with every mark, as before. Raw SQL so the
  // column needs no regenerated Prisma client. The alias conditions are the
  // former Prisma filters: `every siteTitle in seen` = no alias outside seen,
  // `none` = no alias at all.
  const aliasCond = evenWithAlias
    ? 'NOT EXISTS (SELECT 1 FROM gep_song_aliases a WHERE a.singer_song_id = s.id AND NOT (a.site_title = ANY($4::text[])))'
    : 'NOT EXISTS (SELECT 1 FROM gep_song_aliases a WHERE a.singer_song_id = s.id)';
  const mark = () => prisma.$executeRawUnsafe(
    `UPDATE gep_singer_songs s
        SET review_since = CASE WHEN s.needs_review_at IS NULL THEN $3::timestamptz
                                ELSE COALESCE(s.review_since, s.needs_review_at) END,
            needs_review_at = $3::timestamptz
      WHERE s.singer = $1 AND s.title = $2 AND ${aliasCond}`,
    singer, title, now.toISOString(), ...(evenWithAlias ? [seenAliases.map(String)] : [])
  );
  try {
    (async () => {
      const count = await mark();
      if (count) return;
      // No row to mark (or it has a 网站歌名): make one only if none exists.
      try {
        const row = await prisma.gepSingerSong.create({ data: { singer, title, source: 'game', needsReviewAt: now } });
        await prisma.$executeRawUnsafe('UPDATE gep_singer_songs SET review_since = needs_review_at WHERE id = $1::uuid', row.id);
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
  const { fetchCandidatesWithSameName } = require('./captureService');
  const pool = [];
  for (const st of siteTitles) pool.push(...await fetchCandidatesWithSameName(st));
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
const siteExactCache = new Map(); // title -> { exact, at, fp }
async function siteHasExact(title) {
  const { fetchCandidatesWithSameName, catalogueFingerprint } = require('./captureService');
  // Only for the catalogue it was worked out on (2026-11-17): an upload
  // changes the fingerprint at the hourly check, and a "no such song" from
  // before it must not keep marking the title 待处理 for up to 6 more hours.
  // Read before the lookup: an index swapped in while it awaits must not
  // label an answer worked out on the old one.
  const fp = catalogueFingerprint();
  const hit = siteExactCache.get(title);
  if (hit && hit.fp === fp && Date.now() - hit.at < SITE_EXACT_TTL_MS) return hit.exact;
  const text = `《${title}》`;
  const exact = matchTitle(text, await fetchCandidatesWithSameName(text)).candidates.some((c) => c.kind === 'exact');
  if (siteExactCache.size >= 5000) siteExactCache.clear();
  siteExactCache.set(title, { exact, at: Date.now(), fp });
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
      lastSeenAt: r.lastSeenAt,
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

/**
 * 对比歌单: which of this singer's titles a playlist does not have. Read-only.
 *
 * "Has it" is the title alone, whoever sings it: a song in the playlist whose
 * title is an exact match (the same test 歌P tagging likes on) for the game
 * title or for one of its 网站歌名. A title that is there only with different
 * bracketed text ("十年（Live）") still counts as missing, with that title shown
 * beside it so the difference is easy to judge.
 *
 * Only the caller's own playlists and those shared with them; anything else
 * is not found, the same as a playlist that does not exist.
 */
async function comparePlaylist(singerRaw, playlistIdRaw, userId) {
  const singer = cleanSinger(singerRaw);
  if (!singer) throw new ValidationError({ singer: ['缺少歌手'] });
  const playlistId = String(playlistIdRaw || '');
  if (!UUID_RE.test(playlistId)) throw new NotFoundError('Playlist');
  const playlist = await prisma.playlist.findFirst({
    where: { id: playlistId, OR: [{ userId }, { shares: { some: { userId } } }] },
    select: { id: true, name: true },
  });
  if (!playlist) throw new NotFoundError('Playlist');

  const [songs, rows] = await Promise.all([
    prisma.gepSingerSong.findMany({
      where: { singer },
      select: { id: true, title: true, aliases: { select: { siteTitle: true }, orderBy: { createdAt: 'asc' } } },
    }),
    // Only the distinct titles, in one indexed read: a 10,000-clip playlist
    // measured 150ms here against 790ms through nested Prisma selects.
    prisma.$queryRawUnsafe(
      `SELECT DISTINCT s.title FROM playlist_clips pc
         JOIN clips c ON c.id = pc.clip_id
         JOIN songs s ON s.id = c.song_id
        WHERE pc.playlist_id = $1::uuid`,
      playlistId,
    ),
  ]);

  // The playlist's titles filed by normTitle: an exact match always shares
  // the key, so each lookup compares against a handful, not the whole list.
  const byKey = new Map();
  for (const r of rows) {
    const t = r.title;
    const k = t && normTitle(t);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(t);
  }
  const sameKey = (name) => [...(byKey.get(normTitle(name)) || [])];
  const has = (name) => sameKey(name).some((t) => {
    const cmp = compareTitles(name, t);
    return cmp && cmp.kind === 'exact';
  });

  const missing = [];
  for (const s of sortByPinyin(songs, (r) => r.title)) {
    const siteTitles = s.aliases.map((a) => a.siteTitle);
    const names = [s.title, ...siteTitles];
    if (names.some(has)) continue;
    const near = [...new Set(names.flatMap(sameKey))].slice(0, 3);
    missing.push({ id: s.id, title: s.title, siteTitles, near });
  }
  return { singer, playlist, total: songs.length, missing };
}

/**
 * 重新解析: after songs were uploaded, clear the 待处理 they answer.
 *
 * A title is cleared when the catalogue now holds a song of exactly its name
 * -- exactly as 歌P's own auto-like means it (matchTitle 'exact': 《》, spaces,
 * case and a "- Live" tail do not count; width and bracket text do) -- and
 * every such song was uploaded after this 待处理 began (review_since, less
 * the hour the 歌P index may take to see an upload -- SEEN_LAG_MS). One
 * that was already there means the title was flagged for another reason (the
 * playlist holds only a near-named version), which an upload does not fix.
 * Nothing else is touched: no 网站歌名, no capture, no report.
 *
 * The catalogue is read now (not at the next hourly check) and the 6-hour
 * same-name answers are dropped, so a song uploaded a minute ago counts and
 * QQ打标 does not mark it again from a stale "none". One title at a time; one
 * run at a time -- a second click while it runs gets the same answer.
 */
// The hourly catalogue check (captureService KEYS_CHECK_MS) plus a margin.
const SEEN_LAG_MS = 65 * 60 * 1000;
let reresolving = null;
// A click within this long of the last run gets that run's answer: each run
// re-reads the catalogue (an md5 over every song) and walks every 待处理.
const RERESOLVE_COOLDOWN_MS = 30 * 1000;
let lastReresolve = null; // { at, result }
function reresolveReview() {
  if (reresolving) return reresolving;
  if (lastReresolve && Date.now() - lastReresolve.at < RERESOLVE_COOLDOWN_MS) return Promise.resolve(lastReresolve.result);
  reresolving = runReresolve()
    .then((result) => { lastReresolve = { at: Date.now(), result }; return result; })
    .finally(() => { reresolving = null; });
  return reresolving;
}

async function runReresolve() {
  // Late: captureService requires this module.
  const { fetchCandidatesWithSameName, refreshCatalogue } = require('./captureService');
  await refreshCatalogue();
  siteExactCache.clear();

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, singer, title, needs_review_at, COALESCE(review_since, needs_review_at) AS since
       FROM gep_singer_songs WHERE needs_review_at IS NOT NULL ORDER BY singer, title`
  );
  const cleared = [];
  for (const r of rows) {
    const text = `《${r.title}》`;
    const exact = matchTitle(text, await fetchCandidatesWithSameName(text)).candidates.filter((c) => c.kind === 'exact');
    if (!exact.length) continue;
    // "Already there when flagged" counts only songs uploaded SEEN_LAG_MS
    // before the flag: the 歌P index sees an upload at its next hourly check,
    // so a title flagged in that hour was flagged because the song could not
    // yet be seen -- the case 重新解析 is for. (A title flagged then for the
    // other reason, a near-named version in the playlist, and cleared here by
    // this, is flagged again by its next capture.)
    const [age] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE created_at <= $2)::int AS before
         FROM songs WHERE id = ANY($1::uuid[])`,
      exact.map((c) => String(c.songId)), new Date(new Date(r.since).getTime() - SEEN_LAG_MS)
    );
    if (!age.n || age.before > 0) continue;
    // Only if it was not marked again meanwhile: a newer mark is the newer answer.
    const n = await prisma.$executeRawUnsafe(
      'UPDATE gep_singer_songs SET needs_review_at = NULL WHERE id = $1::uuid AND needs_review_at = $2',
      r.id, r.needs_review_at
    );
    if (n) cleared.push({ singer: r.singer, title: r.title });
  }
  const remaining = await prisma.gepSingerSong.count({ where: { needsReviewAt: { not: null } } });
  return { checked: rows.length, cleared, remaining };
}

module.exports = {
  note, siteTitlesFor, matchSiteTitles, creditsSinger, cleanTitle, cleanSinger,
  aliasAutoOk, noteReview, aliasOnSite, reviewAgainstSite,
  listSingers, listSongs, addSong, deleteSong, addAlias, deleteAlias, clearReview,
  comparePlaylist, reresolveReview,
};
