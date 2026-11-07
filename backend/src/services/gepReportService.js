/**
 * 歌P战报 — what one 歌P run saw, kept for 7 days.
 *
 * A run is the span from aiming 自动打标 at a list (a playlist here, or a QQ /
 * NetEase list for 平台打标) to 停止, a switch to another list or to 唱卡, or
 * the connection ending. One connection can carry many runs in a day.
 *
 * Everything here is a side record. The capture path calls in after it has
 * answered and never waits on it: a failure is logged and the capture goes on
 * exactly as before. Nothing in matching, liking or routing reads these tables.
 *
 * A report is fixed once its run is over. Adding the missing songs afterwards
 * does not change it — the point is to remember which songs this game showed
 * that the list did not have.
 */

const path = require('path');
const prisma = require('../db/client');
const { NotFoundError, ForbiddenError, ValidationError } = require('../utils/errors');
const { matchTitle } = require('./captureMatchService');
const { sliceLRC } = require('../utils/lrc');
const { pickStart, buildClipFilename } = require('../../scripts/lib/add-songs');
const { clipAudioAsync } = require('../../scripts/clip-audio');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const CLIP_LENGTH = 20;
const MAX_TITLE = 100;
const MAX_SINGER = 64;
const MAX_OPTIONS = 8;
const MAX_ADD = 100;

// Site captures: not_in_playlist (the catalogue has it, this list does not) and
// no_match (nothing found) are what the list is missing. Every other outcome
// found the song in the list.
const SITE_MISSING = new Set(['not_in_playlist', 'no_match']);
// Platform captures: decided later while 'matching' / 'unread'.
const PLATFORM_UNSETTLED = new Set(['matching', 'unread']);

function statusOf(source, outcome, candidates) {
  if (!outcome) return 'unknown';
  if (source === 'site') return SITE_MISSING.has(outcome) ? 'missing' : 'have';
  if (PLATFORM_UNSETTLED.has(outcome)) return 'unknown';
  if (outcome === 'no_match') return 'missing';
  // 'pending' with nothing matched is a capture that was only recorded
  // (网易云打标 switched off), not one that found the song in the list.
  if (outcome === 'pending' && !(Array.isArray(candidates) && candidates.length)) return 'unknown';
  return 'have';
}

function sourceOfRef(ref) {
  return String(ref || '').startsWith('netease') ? 'netease' : 'qq';
}

// --- one at a time per connection -------------------------------------------
// Captures arrive every couple of seconds and a run can start between two of
// them. Serialising per connection keeps "is there an open report?" and
// "open one" from racing into two reports, and keeps items in arrival order.
const queues = new Map();
function serial(sessionId, fn) {
  const prev = queues.get(sessionId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(sessionId, tail);
  tail.then(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId); });
  return next;
}

// One line per kind of failure per minute: if the tables are missing (code
// deployed ahead of its migration) every capture would fail here, and the
// log must not fill with it.
const lastWarned = new Map();
function warn(label, err) {
  const now = Date.now();
  if (now - (lastWarned.get(label) || 0) < 60000) return;
  lastWarned.set(label, now);
  const msg = String((err && err.message) || err).trim().split(/\r?\n/).filter(Boolean).pop();
  console.warn(`[gep-report] ${label} failed (further failures quiet for 60s): ${msg}`);
}

function quietly(label, p) {
  return Promise.resolve(p).catch((err) => warn(label, err));
}

// What the capture path and the aim/stop paths call. Whatever goes wrong in
// here -- a throw before the first await included -- stays in here: the
// caller gets a settled promise and carries on exactly as it did before.
function guarded(label, fn) {
  return (...args) => {
    try {
      return quietly(label, fn(...args));
    } catch (err) {
      warn(label, err);
      return Promise.resolve();
    }
  };
}

// The client sends the title on screen every ~2s sweep, ~15 times a song.
// Once a song is in this run's report there is nothing more to write, so a
// repeat is dropped here without touching the database. Keyed by the run
// as this process knows it: every boundary below bumps the connection's
// generation, so a new run on the same list records its songs afresh. A
// restart forgets it all, which only means one database check per song.
const generations = new Map();
const recorded = new Set();
// A song whose status was still undecided when last seen (a QQ title being
// matched, or 网易云打标 switched off, where it stays undecided): looked at
// again at most every UNSETTLED_RECHECK_MS rather than on every re-send.
const unsettledAt = new Map();
const UNSETTLED_RECHECK_MS = 30000;
const MAX_RECORDED = 50000;
function bump(sessionId) {
  // Bounded. Clearing the generations restarts every key at 0, so what was
  // recorded under the old numbers has to go with them.
  if (generations.size >= MAX_RECORDED) { generations.clear(); recorded.clear(); unsettledAt.clear(); }
  generations.set(sessionId, (generations.get(sessionId) || 0) + 1);
}
function recordKey(sessionId, eventId) {
  return `${sessionId}|${generations.get(sessionId) || 0}|${eventId}`;
}

let lastPrune = 0;
async function maybePrune() {
  if (Date.now() - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = Date.now();
  await prisma.gepReport.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - RETENTION_MS) } } });
}

// --- run boundaries ---------------------------------------------------------

async function closeOpenFor(where, at = new Date()) {
  await prisma.gepReport.updateMany({ where: { ...where, endedAt: null }, data: { endedAt: at } });
}

// Connections known to have no open report, so ending a run that is not
// there -- aiming at 唱卡, 停止 with nothing running -- costs no query at all.
// Learned once per connection per process; opening a report clears it.
const noOpen = new Set();
async function endRunOf(sessionId) {
  if (noOpen.has(sessionId)) return;
  await closeOpenFor({ sessionId });
  if (noOpen.size >= MAX_RECORDED) noOpen.clear();
  noOpen.add(sessionId);
}

// Users known to have no open report anywhere, so a new connection (which
// ends the old ones) costs no query for someone who never runs 歌P.
const noOpenUsers = new Set();
async function endRunsOfUser(userId) {
  if (noOpenUsers.has(userId)) return;
  await closeOpenFor({ userId });
  if (noOpenUsers.size >= MAX_RECORDED) noOpenUsers.clear();
  noOpenUsers.add(userId);
}

async function createReport({ session, source, playlistId = null, platformRef = null, name }) {
  await closeOpenFor({ sessionId: session.id });
  noOpen.delete(session.id);
  noOpenUsers.delete(session.userId);
  await quietly('prune', maybePrune());
  return prisma.gepReport.create({
    data: {
      userId: session.userId,
      sessionId: session.id,
      source,
      playlistId,
      platformRef,
      playlistName: String(name || '').slice(0, 200) || (source === 'site' ? '歌单' : '平台歌单'),
    },
  });
}

async function playlistName(playlistId) {
  const p = await prisma.playlist.findUnique({ where: { id: playlistId }, select: { name: true } });
  return p ? p.name : '歌单';
}

/**
 * The connection was re-aimed (site 自动打标, 停止, 唱卡). A new playlist starts
 * a run; aiming again at the list the open run is on (a page reload re-aims)
 * keeps it; anything else ends it. Never throws.
 */
function onTarget(session) {
  if (!session) return Promise.resolve();
  bump(session.id);
  return serial(session.id, async () => {
    if (session.target === 'playlist' && session.playlistId) {
      const open = await prisma.gepReport.findFirst({
        where: { sessionId: session.id, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (open && open.source === 'site' && open.playlistId === session.playlistId) return;
      await createReport({
        session, source: 'site', playlistId: session.playlistId, name: await playlistName(session.playlistId),
      });
      return;
    }
    // 平台打标 opens its own run in onPlatformStart, with the list's title.
    if (session.target === 'platform') return;
    await endRunOf(session.id);
  });
}

/** 平台打标 开始: always a new run, as the platform service treats it. Never throws. */
function onPlatformStart(session, title) {
  if (!session || !session.platformRef) return Promise.resolve();
  bump(session.id);
  return serial(session.id, () => createReport({
    session, source: sourceOfRef(session.platformRef), platformRef: session.platformRef, name: title,
  }));
}

/** The connection is over (or replaced by a new one). Never throws. */
function onSessionEnd({ sessionId, userId } = {}) {
  if (sessionId) {
    bump(sessionId);
    return serial(sessionId, () => endRunOf(sessionId));
  }
  if (userId) return endRunsOfUser(userId);
  return Promise.resolve();
}

// --- captures ---------------------------------------------------------------

/**
 * Record one capture the route has already answered. Called without waiting;
 * never throws. `result` is what the capture path returned.
 */
function noteCapture({ session, target, text, singer, result }) {
  const seenAt = new Date();
  if (!session || !result || !result.eventId) return Promise.resolve();
  if (target !== 'playlist' && target !== 'platform') return Promise.resolve();
  const key = recordKey(session.id, result.eventId);
  if (recorded.has(key)) return Promise.resolve();
  const lastUnsettled = unsettledAt.get(key);
  if (lastUnsettled && Date.now() - lastUnsettled < UNSETTLED_RECHECK_MS) return Promise.resolve();
  return serial(session.id, async () => {
    let source; let listKey; let outcome; let candidates; let rawText;
    if (target === 'playlist') {
      const ev = await prisma.captureEvent.findUnique({
        where: { id: result.eventId }, select: { sessionId: true, playlistId: true, outcome: true, rawText: true },
      });
      if (!ev || ev.sessionId !== session.id || !ev.playlistId) return;
      source = 'site'; listKey = ev.playlistId; outcome = ev.outcome; rawText = ev.rawText;
    } else {
      const ev = await prisma.platformTagEvent.findUnique({
        where: { id: result.eventId },
        select: { sessionId: true, playlistRef: true, outcome: true, candidates: true, rawText: true },
      });
      if (!ev || ev.sessionId !== session.id) return;
      source = sourceOfRef(ev.playlistRef); listKey = ev.playlistRef; outcome = ev.outcome;
      candidates = ev.candidates; rawText = ev.rawText;
    }
    rawText = String(rawText || text || '').trim();
    if (!rawText) return;

    let report = await prisma.gepReport.findFirst({
      where: { sessionId: session.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    const sameList = report && (source === 'site'
      ? report.source === 'site' && report.playlistId === listKey
      : report.source !== 'site' && report.platformRef === listKey);
    if (!sameList) {
      const listWhere = source === 'site' ? { source: 'site', playlistId: listKey } : { platformRef: listKey };
      // Seen before 停止 but recorded after it: it belongs to the run that
      // just ended, not to a new one.
      const justEnded = await prisma.gepReport.findFirst({
        where: { sessionId: session.id, ...listWhere, endedAt: { gte: seenAt } },
        orderBy: { startedAt: 'desc' },
      });
      if (justEnded) {
        report = justEnded;
      } else {
        // A run already under way when this was deployed, or a boundary that
        // was missed: start the report here rather than lose the run -- but
        // only while the connection is still aimed at this list.
        const s = await prisma.captureSession.findUnique({
          where: { id: session.id }, select: { target: true, playlistId: true, platformRef: true, endedAt: true },
        });
        const aimed = s && !s.endedAt && (source === 'site'
          ? s.target === 'playlist' && s.playlistId === listKey
          : s.target === 'platform' && s.platformRef === listKey);
        if (!aimed) return;
        report = await createReport({
          session,
          source,
          playlistId: source === 'site' ? listKey : null,
          platformRef: source === 'site' ? null : listKey,
          name: source === 'site' ? await playlistName(listKey) : null,
        });
      }
    }

    const status = statusOf(source, outcome, candidates);
    const existing = await prisma.gepReportItem.findUnique({
      where: { reportId_rawText: { reportId: report.id, rawText } },
    });
    if (!existing) {
      await prisma.gepReportItem.create({ data: { reportId: report.id, rawText, status, seenAt } });
    } else if (existing.status === 'unknown' && status !== 'unknown') {
      await prisma.gepReportItem.update({ where: { id: existing.id }, data: { status } });
    }
    const name = typeof singer === 'string' ? singer.trim().slice(0, MAX_SINGER) : '';
    if (name && report.singer == null) {
      await prisma.gepReport.updateMany({ where: { id: report.id, singer: null }, data: { singer: name } });
    }
    // Settled for this run: later repeats can skip the database. Not while the
    // song's status is still undecided. (The singer comes with every capture
    // from a client that sends it, so another song of the run supplies it.)
    if (status !== 'unknown') {
      if (recorded.size >= MAX_RECORDED) recorded.clear();
      recorded.add(key);
      unsettledAt.delete(key);
    } else {
      if (unsettledAt.size >= MAX_RECORDED) unsettledAt.clear();
      unsettledAt.set(key, Date.now());
    }
  });
}

// --- reading ----------------------------------------------------------------

async function ownReport(userId, reportId) {
  const report = await prisma.gepReport.findUnique({ where: { id: String(reportId || '') } }).catch(() => null);
  if (!report) throw new NotFoundError('Report');
  // Someone else's report is "not found", not "forbidden": no hint it exists.
  if (report.userId !== userId) throw new NotFoundError('Report');
  if (report.startedAt.getTime() < Date.now() - RETENTION_MS) throw new NotFoundError('Report');
  return report;
}

/** Whether the run is still going: open, and its connection still live. */
async function isRunning(report) {
  if (report.endedAt) return false;
  const s = await prisma.captureSession.findUnique({
    where: { id: report.sessionId }, select: { endedAt: true, expiresAt: true },
  });
  return !!s && !s.endedAt && s.expiresAt.getTime() > Date.now();
}

// A platform title decided after it was seen: settle it from its event.
async function settleUnknown(report, items) {
  if (report.source === 'site') return items;
  const open = items.filter((i) => i.status === 'unknown');
  if (!open.length) return items;
  const rows = await prisma.platformTagEvent.findMany({
    where: { sessionId: report.sessionId, playlistRef: report.platformRef, rawText: { in: open.map((i) => i.rawText) } },
    select: { rawText: true, outcome: true, candidates: true },
  });
  const byText = new Map(rows.map((r) => [r.rawText, r]));
  for (const item of open) {
    const r = byText.get(item.rawText);
    const status = r ? statusOf(report.source, r.outcome, r.candidates) : 'unknown';
    if (status !== 'unknown') {
      item.status = status;
      await prisma.gepReportItem.update({ where: { id: item.id }, data: { status } }).catch(() => {});
    }
  }
  return items;
}

function artistMatches(singer, artist) {
  const want = String(singer || '').trim().toLowerCase();
  if (!want) return false;
  return String(artist || '').split('_').map((a) => a.trim().toLowerCase())
    .some((a) => a && (a.includes(want) || want.includes(a)));
}

/**
 * Where a title would be found in the catalogue: the same title matching the
 * capture path uses, with the run's singer preferred among same-name songs.
 */
// The catalogue search scans the songs table, and a run in progress is
// re-read every 10s: the same title is looked up once per 10 minutes.
const lookupCache = new Map();
const LOOKUP_TTL_MS = 10 * 60 * 1000;
const MAX_LOOKUPS_PER_READ = 200;

async function lookup(title, singer) {
  const t = String(title || '').trim();
  if (!t) return { found: false, options: [], pick: null };
  const cacheKey = `${t}\u0001${String(singer || '').trim()}`;
  const hit = lookupCache.get(cacheKey);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.value;
  const { fetchCandidateSongs } = require('./captureService');
  const { candidates } = matchTitle(t, await fetchCandidateSongs(t));
  const credited = candidates.filter((c) => artistMatches(singer, c.artist));
  const ordered = [...credited, ...candidates.filter((c) => !credited.includes(c))].slice(0, MAX_OPTIONS);
  const options = ordered.map((c) => ({ songId: c.songId, title: c.title, artist: c.artist }));
  const value = { found: options.length > 0, options, pick: options[0] ? options[0].songId : null };
  if (lookupCache.size >= 5000) lookupCache.clear();
  lookupCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function itemView(item) {
  return {
    id: item.id,
    rawText: item.rawText,
    title: item.title,
    status: item.status,
    seenAt: item.seenAt,
  };
}

async function listReports(userId) {
  await quietly('prune', maybePrune());
  const reports = await prisma.gepReport.findMany({
    where: { userId, startedAt: { gte: new Date(Date.now() - RETENTION_MS) } },
    orderBy: { startedAt: 'desc' },
    take: 500,
  });
  if (!reports.length) return { reports: [] };
  const counts = await prisma.gepReportItem.groupBy({
    by: ['reportId', 'status'],
    where: { reportId: { in: reports.map((r) => r.id) } },
    _count: { _all: true },
  });
  const tally = new Map();
  for (const c of counts) {
    const t = tally.get(c.reportId) || { total: 0, missing: 0 };
    t.total += c._count._all;
    if (c.status === 'missing') t.missing += c._count._all;
    tally.set(c.reportId, t);
  }
  // Whether each still-open run's connection is live, in one read.
  const openIds = [...new Set(reports.filter((r) => !r.endedAt).map((r) => r.sessionId))];
  const sessions = openIds.length
    ? await prisma.captureSession.findMany({ where: { id: { in: openIds } }, select: { id: true, endedAt: true, expiresAt: true } })
    : [];
  const live = new Set(sessions.filter((s) => !s.endedAt && s.expiresAt.getTime() > Date.now()).map((s) => s.id));
  const out = [];
  for (const r of reports) {
    const t = tally.get(r.id) || { total: 0, missing: 0 };
    const running = !r.endedAt && live.has(r.sessionId);
    // A run that never saw a song is not worth a card.
    if (!t.total && !running) continue;
    out.push({
      id: r.id, source: r.source, playlistName: r.playlistName, singer: r.singer,
      startedAt: r.startedAt, endedAt: r.endedAt, running, total: t.total, missing: t.missing,
    });
  }
  return { reports: out };
}

async function getReport(userId, reportId) {
  const report = await ownReport(userId, reportId);
  let items = await prisma.gepReportItem.findMany({ where: { reportId: report.id }, orderBy: [{ seenAt: 'asc' }, { id: 'asc' }] });
  items = await settleUnknown(report, items);
  const running = await isRunning(report);
  const last = items.length ? items[items.length - 1].seenAt : null;
  const views = [];
  let looked = 0;
  for (const item of items) {
    const v = itemView(item);
    if (item.status === 'missing') {
      // Bounded per read; past it a song is looked up when the user renames it.
      v.lookup = looked++ < MAX_LOOKUPS_PER_READ
        ? await lookup(item.title || item.rawText, report.singer)
        : { found: false, options: [], pick: null, skipped: true };
    }
    views.push(v);
  }
  // The default destination: the run's own playlist, if it is the user's to
  // add to. A platform run, or a list someone shared, has none.
  let defaultPlaylistId = null;
  if (report.source === 'site' && report.playlistId) {
    const p = await prisma.playlist.findUnique({ where: { id: report.playlistId }, select: { userId: true } });
    if (p && p.userId === userId) defaultPlaylistId = report.playlistId;
  }
  // Where songs can go: the user's own playlists, newest first.
  const myPlaylists = await prisma.playlist.findMany({
    where: { userId }, select: { id: true, name: true }, orderBy: { updatedAt: 'desc' }, take: 1000,
  });
  return {
    myPlaylists,
    report: {
      id: report.id, source: report.source, playlistName: report.playlistName, singer: report.singer,
      startedAt: report.startedAt, endedAt: report.endedAt || (running ? null : last || report.startedAt),
      running, defaultPlaylistId,
    },
    items: views,
  };
}

/**
 * The most recent report, for the 查看本局战报 link -- the run just stopped,
 * even when it saw no songs (the list leaves those out; this must not fall
 * back to an older run of another list).
 */
async function latestReportId(userId) {
  const r = await prisma.gepReport.findFirst({
    where: { userId, startedAt: { gte: new Date(Date.now() - RETENTION_MS) } },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
  return r ? r.id : null;
}

// --- editing ----------------------------------------------------------------

async function renameItem(userId, reportId, itemId, title) {
  const report = await ownReport(userId, reportId);
  const item = await prisma.gepReportItem.findUnique({ where: { id: String(itemId || '') } }).catch(() => null);
  if (!item || item.reportId !== report.id) throw new NotFoundError('Song');
  if (title != null && typeof title !== 'string') throw new ValidationError({ title: ['Title must be text'] });
  const clean = String(title || '').trim().slice(0, MAX_TITLE);
  // Empty, or the captured title itself, means "no correction".
  const stored = clean && clean !== item.rawText ? clean : null;
  const updated = await prisma.gepReportItem.update({ where: { id: item.id }, data: { title: stored } });
  const v = itemView(updated);
  if (updated.status === 'missing') v.lookup = await lookup(updated.title || updated.rawText, report.singer);
  return { item: v };
}

async function setSinger(userId, reportId, singer) {
  const report = await ownReport(userId, reportId);
  if (singer != null && typeof singer !== 'string') throw new ValidationError({ singer: ['Singer must be text'] });
  // Stored as typed; an empty string (not null) so a later capture of the
  // run does not put the game's singer back over the user's choice.
  const clean = String(singer || '').trim().slice(0, MAX_SINGER);
  await prisma.gepReport.update({ where: { id: report.id }, data: { singer: clean } });
  return getReport(userId, reportId);
}

// --- adding to a playlist ---------------------------------------------------

/**
 * Add chosen songs to one of the user's own playlists. Each song goes in as
 * a playlist import would put it: the second start when there is one, else
 * the first (pickStart), reusing a clip at that start or cutting one. A song
 * already in the playlist is skipped. The report itself is not changed.
 */
// One add at a time per user: two tabs, or a retry after a timeout, would
// otherwise read the same last position and could cut the same clip twice.
function addToPlaylist(userId, reportId, body) {
  return serial(`add:${userId}`, () => addOne(userId, reportId, body));
}

async function addOne(userId, reportId, { playlistId, picks }) {
  const report = await ownReport(userId, reportId);
  if (!playlistId || typeof playlistId !== 'string') throw new ValidationError({ playlistId: ['Choose a playlist'] });
  if (!Array.isArray(picks) || !picks.length) throw new ValidationError({ picks: ['Choose at least one song'] });
  if (picks.length > MAX_ADD) throw new ValidationError({ picks: [`At most ${MAX_ADD} songs at a time`] });

  const playlist = await prisma.playlist.findUnique({ where: { id: playlistId }, select: { id: true, userId: true } }).catch(() => null);
  if (!playlist) throw new NotFoundError('Playlist');
  if (playlist.userId !== userId) throw new ForbiddenError('Only your own playlists can be added to');

  const items = await prisma.gepReportItem.findMany({ where: { reportId: report.id } });
  const byId = new Map(items.map((i) => [i.id, i]));

  const held = await prisma.playlistClip.findMany({ where: { playlistId }, select: { clip: { select: { songId: true } } } });
  const inList = new Set(held.map((h) => h.clip.songId));
  const maxPos = await prisma.playlistClip.aggregate({ where: { playlistId }, _max: { position: true } });
  let position = (maxPos._max.position ?? -1) + 1;

  const results = [];
  for (const pick of picks) {
    const item = pick && byId.get(String(pick.itemId || ''));
    if (!item) { results.push({ itemId: pick && pick.itemId, result: 'invalid' }); continue; }
    const song = pick.songId
      ? await prisma.song.findUnique({ where: { id: String(pick.songId) } }).catch(() => null)
      : null;
    if (!song) { results.push({ itemId: item.id, result: 'not_found' }); continue; }
    if (inList.has(song.id)) {
      results.push({ itemId: item.id, result: 'exists', title: song.title, artist: song.artist });
      continue;
    }
    try {
      const clip = await clipFor(song);
      await prisma.playlistClip.create({ data: { playlistId, clipId: clip.id, position } });
      position++;
      inList.add(song.id);
      results.push({ itemId: item.id, result: 'added', title: song.title, artist: song.artist });
    } catch (err) {
      console.warn('[gep-report] add failed:', String(err.message || err).split(/\r?\n/)[0].slice(0, 300));
      results.push({ itemId: item.id, result: 'failed', title: song.title, artist: song.artist });
    }
  }
  return { results };
}

// Same choice and the same clip a playlist import makes (scripts/lib/add-songs),
// except that a clip that could not be cut is not recorded: the song is
// reported as not added, rather than added as a clip with no audio.
async function clipFor(song) {
  const startSec = pickStart(song.starts);
  const existing = await prisma.clip.findFirst({ where: { songId: song.id, start: startSec, isGlobal: true } })
    || await prisma.clip.findFirst({ where: { songId: song.id, start: startSec } });
  if (existing) return existing;
  const clipLyrics = sliceLRC(song.lyrics, startSec, startSec + CLIP_LENGTH);
  const clipFilename = buildClipFilename(song.title, song.artist, startSec);
  await clipAudioAsync({
    sourcePath: path.join(process.env.MP3_BASE_PATH, song.filePath),
    outputPath: path.join(process.env.CLIPS_BASE_PATH, clipFilename),
    start: startSec,
    length: CLIP_LENGTH,
    lyrics: clipLyrics,
  });
  return prisma.clip.create({
    data: { songId: song.id, start: startSec, length: CLIP_LENGTH, filePath: clipFilename, lyrics: clipLyrics },
  });
}

module.exports = {
  // The four the existing paths call: guarded, so they can only ever log.
  onTarget: guarded('target', onTarget),
  onPlatformStart: guarded('platform start', onPlatformStart),
  onSessionEnd: guarded('session end', onSessionEnd),
  noteCapture: guarded('capture', noteCapture),
  listReports, getReport, latestReportId, renameItem, setSinger, addToPlaylist,
  // For tests.
  _statusOf: statusOf,
  _settle: (sessionId) => queues.get(sessionId) || Promise.resolve(),
  RETENTION_MS,
};
