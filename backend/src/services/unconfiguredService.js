/**
 * 未配置 — songs the game has shown that nothing in the catalogue answers.
 *
 * The other three buckets all look outward from the catalogue: what has been
 * claimed, what is waiting to be judged, what has never turned up in play.
 * This one looks the other way, from the game inward, and it is the only view
 * that can show a gap — a song people are singing that we cannot play at all.
 *
 * Computed on every read rather than stored. A capture's `outcome` records what
 * was true the moment it arrived, and the two things that decide it both move
 * afterwards: the catalogue grows, and the artist list that fixes a bad split
 * gets edited. A stored answer would keep saying "unmapped" about a song that
 * became playable an hour later, which is exactly the state this page exists to
 * find. So the split is redone and the pool re-queried each time, and the list
 * shrinks by itself as the real fixes land.
 *
 * Grouped by the game's own text, not by row: a song sits on screen for seconds
 * and is read many times, and 438 rows are 321 songs.
 */
const XLSX = require('xlsx');
const prisma = require('../db/client');
const { AppError } = require('../utils/errors');
const { titleKey, artistKey } = require('./songKeyService');
const { splitTitleArtist, loadDashedArtists } = require('./captureService');
const { resolveGameSong } = require('./mappingResolveService');
const review = require('./mappingReviewService');

/** Never build a page larger than this, however many rows are unresolved. */
const PAGE_SIZE = 100;
/** Candidates offered when the title alone matches something. */
const MAX_SUGGESTIONS = 8;

/**
 * Every distinct game text that currently resolves to nothing.
 *
 * Two queries and one pass, rather than a query per row: the pool is thousands
 * of rows and the unresolved list is hundreds, so asking per song would be
 * hundreds of round trips for a page nobody wants to wait for.
 */
async function listUnconfigured({ query = '', all = false } = {}) {
  const q = String(query || '').trim();

  // Live captures only. A 歌P capture is a different question -- "which clip of
  // mine is this" -- and is answered against a playlist, not the mapping table.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT raw_text, count(*)::int AS seen, max(created_at) AS last_seen
       FROM capture_events
      WHERE playlist_id IS NULL AND raw_text IS NOT NULL
      GROUP BY raw_text
      ORDER BY max(created_at) DESC`
  );

  const known = await loadDashedArtists();

  // Split first, then ask the mapping table in one go: a text that already has
  // a mapping is configured, whatever its stored outcome says.
  const split = rows.map((r) => {
    const { title, artist } = splitTitleArtist(r.raw_text, known);
    return {
      rawText: r.raw_text,
      seen: r.seen,
      lastSeen: r.last_seen,
      title,
      artist,
      titleKey: titleKey(title),
      artistKey: artistKey(artist),
    };
  }).filter((r) => r.titleKey);

  // Matched in memory against the titles we asked about, rather than with an OR
  // over every (titleKey, artistKey) pair. That OR worked at today's scale and
  // stopped working past 16,383 pairs -- the wire protocol allows 32,767 bound
  // parameters and each pair spends two. This list only ever grows, so a query
  // shaped to fail eventually is a query that will fail on a Saturday.
  //
  // One IN over distinct titles is far smaller (a title repeats across
  // versions) and is covered by the index the resolver already relies on.
  const titleKeys = [...new Set(split.map((s) => s.titleKey))];
  const mapped = titleKeys.length
    ? await prisma.songMapping.findMany({
      where: { titleKey: { in: titleKeys } },
      select: { titleKey: true, artistKey: true },
    })
    : [];
  const has = new Set(mapped.map((m) => `${m.titleKey} :: ${m.artistKey}`));

  const unresolved = split.filter((s) => !has.has(`${s.titleKey} :: ${s.artistKey}`));

  // What the pool could offer, for the two states that are not "nothing at all".
  const keys = [...new Set(unresolved.map((u) => u.titleKey))];
  const pool = keys.length
    ? await prisma.importedTrack.findMany({
      where: { titleKey: { in: keys } },
      select: {
        id: true, source: true, externalId: true, title: true, artist: true,
        titleKey: true, artistKey: true, durationSec: true, album: true, vipOnly: true,
      },
    })
    : [];
  // Grouped on the stored key, not a recomputed one: the pool was normalised by
  // the same rules at import time, and recomputing here would quietly diverge
  // the day those rules change.
  const byTitle = new Map();
  for (const t of pool) {
    if (!byTitle.has(t.titleKey)) byTitle.set(t.titleKey, []);
    byTitle.get(t.titleKey).push(t);
  }

  const out = unresolved.map((u) => {
    const candidates = byTitle.get(u.titleKey) || [];
    const exact = u.artistKey ? candidates.filter((c) => c.artistKey === u.artistKey) : [];
    // A capture with no artist can never be resolved automatically, however
    // many songs share its title: the resolver refuses to create a mapping
    // from a title alone, because 夜夜夜夜 with no artist was once paired with
    // 梁静茹 when the game had said 齐秦. Those are always a human's call.
    const automatable = !!u.artistKey;
    return {
      ...u,
      /**
       * Two states, because there are only two actions: press a button, or go
       * and find the song.
       *
       * A same-titled track in the pool used to be its own state, on the
       * reasoning that the catalogue had something worth choosing between. That
       * was wrong about how this queue fills. Anything worth a human's judgement
       * has already been through 待确认 -- a song still sitting here has had its
       * same-titled candidates looked at and rejected, or never had a real one.
       * Either way the catalogue does not hold the recording the game means, and
       * a matching title is not the same song: 《宁夏》 by someone else is not
       * 《宁夏》, and five candidates for 《世界末日》 can be five wrong answers.
       *
       * So a title match no longer softens the verdict. Either the pool answers
       * outright, or the song is missing and belongs on the shopping list.
       */
      state: (automatable && exact.length) ? 'resolvable' : 'absent',
      suggestions: candidates.slice(0, MAX_SUGGESTIONS).map((c) => ({
        source: c.source,
        externalId: c.externalId,
        title: c.title,
        artist: c.artist,
        durationSec: c.durationSec,
        album: c.album,
        vipOnly: c.vipOnly,
        artistMatches: !!u.artistKey && c.artistKey === u.artistKey,
      })),
    };
  });

  // Counted before the search filter, deliberately: these are the size of the
  // queue, which is what the tab badge and the state filters have to report.
  // Counting the search result instead would make the badge read 3 while 343
  // songs waited behind it.
  const counts = out.reduce((acc, r) => {
    acc[r.state] = (acc[r.state] || 0) + 1;
    return acc;
  }, { resolvable: 0, absent: 0 });
  counts.total = out.length;

  const filtered = q
    ? out.filter((r) => r.rawText.toLowerCase().includes(q.toLowerCase())
      || r.title.toLowerCase().includes(q.toLowerCase())
      || (r.artist || '').toLowerCase().includes(q.toLowerCase()))
    : out;

  // The all flag is for reresolveAll, which must act on everything rather
  // than on whatever fits a screen. The page itself never asks for it.
  const page = all ? filtered : filtered.slice(0, PAGE_SIZE);
  return {
    rows: page,
    counts,
    // How many the search matched, so the page can say so rather than leaving
    // the reader to reconcile a badge of 343 against three rows on screen.
    matched: filtered.length,
    query: q,
    truncated: !all && filtered.length > PAGE_SIZE,
  };
}

/**
 * Run every unresolved capture back through the resolver.
 *
 * The same call the game makes, deliberately: a song configured from here and a
 * song met in play must land in the same state, so an exact agreement on title
 * and artist confirms itself and everything else waits for a human. Keeping a
 * separate rule here would mean two definitions of "good enough" and no way to
 * tell which one produced a given row.
 */
async function reresolveAll() {
  // The full set, not the page. listUnconfigured slices to PAGE_SIZE for the
  // screen, and reusing that slice quietly meant "重新解析" resolved the first
  // hundred of three hundred while reporting that it had finished — the admin
  // would have had to press it four times with nothing saying so.
  const { rows } = await listUnconfigured({ all: true });
  let configured = 0; let stillUnconfigured = 0;
  const failures = [];

  for (const r of rows) {
    if (r.state === 'absent') { stillUnconfigured += 1; continue; }
    try {
      const res = await resolveGameSong({ title: r.title, artist: r.artist });
      if (res && res.mapping) configured += 1;
      else stillUnconfigured += 1;
    } catch (err) {
      stillUnconfigured += 1;
      failures.push({ rawText: r.rawText, message: err.message });
    }
  }
  return { examined: rows.length, configured, stillUnconfigured, failures };
}

/**
 * The songs the catalogue does not have, as a spreadsheet.
 *
 * This is the one state nothing on the page can fix: the others are a button or
 * a judgement, but a song we simply do not hold has to be bought or imported
 * from somewhere else first. So the useful form is a list to take away, and a
 * shopping list wants two columns and no ceremony.
 *
 * Built from the full set rather than the page — the whole point is to leave
 * with everything, and a hundred rows of three hundred is a list that quietly
 * lies about what is missing.
 */
async function absentWorkbook() {
  const { rows } = await listUnconfigured({ all: true });
  const absent = rows.filter((r) => r.state === 'absent');

  // The split's own answer, not the game's raw string: 歌名 and 歌手 are what
  // a search box on a music platform wants, and the raw text has them joined
  // by a dash that means nothing to anyone but us.
  const data = absent.map((r) => ({ 歌名: r.title, 歌手: r.artist || '' }));

  const sheet = XLSX.utils.json_to_sheet(data, { header: ['歌名', '歌手'] });
  // Wide enough for a long Chinese title without dragging the column border.
  sheet['!cols'] = [{ wch: 32 }, { wch: 24 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '曲库没有');

  return {
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    count: data.length,
  };
}

/**
 * Search the catalogue by hand, for the case automatic matching cannot reach.
 *
 * The platforms disagree about titles in ways no key can normalise -- 繁体 for
 * 简体, a "(Live)" suffix, a bracketed show name -- so the song is in the pool
 * and the lookup still misses. Searching by eye is the only way through, and
 * the mapping it produces is a permanent alias: the game's exact wording, bound
 * to the recording a human confirmed.
 */
async function searchPool({ query = '', take = 25 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { rows: [] };
  const limit = Math.min(Math.max(Number(take) || 25, 1), 50);

  const rows = await prisma.importedTrack.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { artist: { contains: q, mode: 'insensitive' } },
        { titleKey: { contains: titleKey(q) } },
        { externalId: q },
      ],
    },
    orderBy: [{ title: 'asc' }],
    take: limit,
    select: {
      id: true, source: true, externalId: true, title: true,
      artist: true, durationSec: true, album: true, vipOnly: true,
    },
  });
  return { rows };
}

/**
 * Bind one game text to one pool track, by hand.
 *
 * Delegates to the review page's own createFromTrack rather than writing the
 * mapping here. It is the same act reached from the other direction, and doing
 * it twice would mean two versions of the bookkeeping around it: that function
 * reads what the game song pointed at before, and releases the abandoned track
 * back to 未遇见 when nothing else claims it. Writing an upsert here instead
 * left that track marked as seen forever, invisible in the coverage bucket
 * with no mapping to find it by.
 *
 * Approved outright, as it is there: a human just listened to it and said so.
 */
async function configure({ rawText, source, externalId, userId }) {
  const known = await loadDashedArtists();
  const { title, artist } = splitTitleArtist(String(rawText || ''), known);
  if (!titleKey(title)) {
    throw new AppError('这条记录没有可用的歌名', 400);
  }

  const track = await prisma.importedTrack.findUnique({
    where: { source_externalId: { source, externalId: String(externalId) } },
    select: { id: true },
  });
  if (!track) {
    throw new AppError('曲库里没有这首歌', 404);
  }

  const mapping = await review.createFromTrack({
    gameTitle: title,
    gameArtist: artist,
    source,
    externalId: String(externalId),
    userId,
    approved: true,
  });
  return { mapping };
}

/**
 * Forget every capture of one game text.
 *
 * For a song the catalogue does not have and is not going to, or one whose text
 * was mangled badly enough that keeping it only clutters the list. Not a
 * blocklist: the next time the game shows it, it arrives fresh and is judged
 * against whatever the catalogue holds then.
 */
async function forget(rawText) {
  const res = await prisma.captureEvent.deleteMany({
    where: { rawText: String(rawText || ''), playlistId: null },
  });
  return { removed: res.count };
}

module.exports = {
  listUnconfigured, reresolveAll, searchPool, configure, forget, absentWorkbook, PAGE_SIZE,
};
