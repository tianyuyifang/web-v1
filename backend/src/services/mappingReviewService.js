/**
 * The review queue behind the mapping admin page.
 *
 * Three buckets, because a row can be in three genuinely different states:
 *
 *   confirmed  a human approved this mapping; playback uses it and automatic
 *              search will not touch it again
 *   pending    a mapping exists but nobody has vouched for it — either the
 *              importer guessed, or a live search picked the best hit
 *   unseen     an imported track that no game song has claimed yet. Not a
 *              mapping at all: it has no game-side key, because the game has
 *              never shown it. This is the coverage counter — it only falls as
 *              songs actually turn up in play.
 *
 * Once a row is approved, where it came from stops mattering, so origin is a
 * label on the row rather than a bucket of its own.
 *
 * Search rather than a full listing: the pool runs to thousands of rows, and
 * the useful question is always "what did the game just show me", never "show
 * me everything".
 */
const prisma = require('../db/client');
const { titleKey, artistKey, artistsOverlap } = require('./songKeyService');
// The project's error classes set statusCode and isOperational, which the error
// handler reads. A bare Error with .status ends up as a 500 with the message
// swallowed — the caller is told 'internal server error' for a missing row.
const { NotFoundError, ValidationError } = require('../utils/errors');

const PAGE_SIZE = 50;
/** Alternatives offered per row. Well past any real number of versions. */
const MAX_CANDIDATES = 25;

/** Counts for the three tabs. Cheap enough to send with every response. */
async function getCounts() {
  const [confirmed, pending, unseen] = await Promise.all([
    prisma.songMapping.count({ where: { approved: true } }),
    prisma.songMapping.count({ where: { approved: false } }),
    prisma.importedTrack.count({ where: { matchedAt: null } }),
  ]);
  return { confirmed, pending, unseen, total: confirmed + pending };
}

/**
 * Rows for one bucket, newest first, optionally narrowed by a search term.
 *
 * The term is matched against the normalised keys as well as the raw text, so
 * typing what the game showed finds the row even when the platform spells the
 * artist differently.
 */
async function list({ bucket = 'pending', query = '', cursor = null, take = PAGE_SIZE } = {}) {
  const q = String(query || '').trim();
  const limit = Math.min(Math.max(Number(take) || PAGE_SIZE, 1), 200);

  if (bucket === 'unseen') {
    const where = q
      ? {
        matchedAt: null,
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { artist: { contains: q, mode: 'insensitive' } },
          { titleKey: { contains: titleKey(q) } },
          // Pasting a platform id should find its row: it is the one value
          // that is unambiguous, and the natural thing to paste when checking
          // a track against the platform itself.
          { externalId: q },
        ],
      }
      : { matchedAt: null };

    const rows = await prisma.importedTrack.findMany({
      where,
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    return {
      bucket,
      rows: rows.slice(0, limit).map((r) => ({
        id: r.id,
        kind: 'imported',
        title: r.title,
        artist: r.artist,
        source: r.source,
        externalId: r.externalId,
        durationSec: r.durationSec,
        album: r.album,
        vipOnly: r.vipOnly,
        playlistRef: r.playlistRef,
      })),
      nextCursor: hasMore ? rows[limit - 1].id : null,
    };
  }

  const approved = bucket === 'confirmed';
  const where = q
    ? {
      approved,
      OR: [
        { rawTitle: { contains: q, mode: 'insensitive' } },
        { rawArtist: { contains: q, mode: 'insensitive' } },
        { platformTitle: { contains: q, mode: 'insensitive' } },
        { titleKey: { contains: titleKey(q) } },
        { externalId: q },
      ],
    }
    : { approved };

  const rows = await prisma.songMapping.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { approvedBy: { select: { username: true } } },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  // Alternatives ride along with the page. The list shows them without being
  // asked, and fetching them per row made one page fifty round trips.
  const alts = await candidatesForMany(page);

  return {
    bucket,
    rows: page.map((m) => ({
      ...shapeMapping(m),
      poolCandidates: alts.get(m.id) || [],
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

function shapeMapping(m) {
  return {
    id: m.id,
    kind: 'mapping',
    // What the game calls it — the key everything is looked up by.
    title: m.rawTitle,
    artist: m.rawArtist,
    titleKey: m.titleKey,
    artistKey: m.artistKey,
    source: m.source,
    externalId: m.externalId,
    // What the platform calls it. Regularly disagrees with the game
    // (凤凰传奇 against 玲花/曾毅) and that is fine once approved — this is here
    // so a human can eyeball whether the pairing looks right.
    platformTitle: m.platformTitle,
    platformArtist: m.platformArtist,
    durationSec: m.durationSec,
    approved: m.approved,
    origin: m.origin,
    matchKind: m.matchKind,
    candidates: m.candidates || [],
    note: m.note,
    approvedBy: m.approvedBy?.username || null,
    approvedAt: m.approvedAt,
  };
}

/** One row with everything needed to judge it. */
async function get(id) {
  const m = await prisma.songMapping.findUnique({
    where: { id },
    include: { approvedBy: { select: { username: true } } },
  });
  if (!m) throw new NotFoundError('Mapping');
  return shapeMapping(m);
}

/** One imported track, so it can be previewed before anyone claims it. */
async function getTrack(id) {
  const t = await prisma.importedTrack.findUnique({ where: { id } });
  if (!t) throw new NotFoundError('Track');
  return t;
}

/**
 * Shape and rank pool tracks against one mapping.
 *
 * Ranked, not filtered: the game and the platform disagree about artists often
 * enough that dropping the non-overlapping ones would hide the right answer.
 *
 * Shared by the single-row route and the batch that rides along with the list,
 * so the two can never disagree about what a candidate looks like or which
 * one sorts first.
 */
function shapeCandidates(mapping, tracks) {
  return tracks
    .map((t) => ({
      source: t.source,
      externalId: t.externalId,
      title: t.title,
      artist: t.artist,
      durationSec: t.durationSec,
      album: t.album,
      vipOnly: t.vipOnly,
      artistMatches: artistsOverlap(mapping.rawArtist, t.artist),
      durationMatches: mapping.durationSec != null && t.durationSec != null
        && Math.abs(mapping.durationSec - t.durationSec) <= 3,
      current: t.source === mapping.source && t.externalId === mapping.externalId,
    }))
    .sort((a, b) => (Number(b.artistMatches) - Number(a.artistMatches))
      || (Number(b.durationMatches) - Number(a.durationMatches)));
}

/**
 * Alternatives for a mapping, drawn from the imported pool.
 *
 * Offered so a reviewer can switch a row without running a fresh search — the
 * pool is local, so this costs nothing and touches no platform.
 */
async function candidatesFor(id) {
  const m = await prisma.songMapping.findUnique({ where: { id } });
  if (!m) throw new NotFoundError('Mapping');

  const sameTitle = await prisma.importedTrack.findMany({
    where: { titleKey: m.titleKey },
    take: MAX_CANDIDATES,
  });

  return shapeCandidates(m, sameTitle);
}

/**
 * Candidates for a whole page of mappings, in one query.
 *
 * The list shows them without being asked now, and fetching per row turned one
 * page into fifty round trips. One `titleKey IN (...)` covers the page, and the
 * index on title_key is the same one the single-row path uses.
 *
 * Capped per title rather than overall: a page where one song has thirty
 * versions must not starve the other rows of theirs.
 */
async function candidatesForMany(mappings) {
  const keys = [...new Set(mappings.map((m) => m.titleKey).filter(Boolean))];
  if (!keys.length) return new Map();

  // Bounded, though the pool today holds at most three versions of any one
  // title: a future import of a heavily-covered song must not be able to pull
  // an unbounded result set into memory to fill one page.
  const tracks = await prisma.importedTrack.findMany({
    where: { titleKey: { in: keys } },
    take: keys.length * MAX_CANDIDATES,
  });

  const byKey = new Map();
  for (const t of tracks) {
    const list = byKey.get(t.titleKey);
    if (list) list.push(t);
    else byKey.set(t.titleKey, [t]);
  }

  const out = new Map();
  for (const m of mappings) {
    const pool = byKey.get(m.titleKey);
    if (!pool || !pool.length) continue;
    out.set(m.id, shapeCandidates(m, pool.slice(0, MAX_CANDIDATES)));
  }
  return out;
}

/**
 * Approve a mapping, optionally repointing it first.
 *
 * Approval freezes the row against automatic search — that freeze is what
 * stops lookups hitting the platforms, so it is the point of the whole page.
 */
async function approve(id, { userId, source, externalId, note } = {}) {
  const m = await prisma.songMapping.findUnique({ where: { id } });
  if (!m) throw new NotFoundError('Mapping');

  const nextSource = source || m.source;
  const nextExternalId = externalId || m.externalId;
  const changed = nextSource !== m.source || nextExternalId !== m.externalId;

  // When the target changes, refresh the platform-side labels from the pool so
  // the row does not keep describing the track it used to point at.
  let platform = {};
  if (changed) {
    const track = await prisma.importedTrack.findUnique({
      where: { source_externalId: { source: nextSource, externalId: nextExternalId } },
    });
    if (track) {
      platform = {
        platformTitle: track.title,
        platformArtist: track.artist,
        durationSec: track.durationSec,
      };
    }
  }

  const updated = await prisma.songMapping.update({
    where: { id },
    data: {
      source: nextSource,
      externalId: nextExternalId,
      ...platform,
      approved: true,
      approvedById: userId,
      approvedAt: new Date(),
      ...(note !== undefined ? { note } : {}),
    },
    include: { approvedBy: { select: { username: true } } },
  });

  // Mark the pool entry as seen, so the coverage counter reflects reality.
  await markSeen(nextSource, nextExternalId);
  // And release the one it just stopped pointing at: repointing abandons a
  // track exactly as deleting the mapping does, and it belongs back in 未遇见
  // unless something else still names it.
  if (changed) await releaseIfUnclaimed(m.source, m.externalId);

  return shapeMapping(updated);
}

/** Withdraw approval, putting the row back in the queue. */
async function unapprove(id) {
  const updated = await prisma.songMapping.update({
    where: { id },
    data: { approved: false, approvedById: null, approvedAt: null },
    include: { approvedBy: { select: { username: true } } },
  }).catch(() => null);
  if (!updated) throw new NotFoundError('Mapping');
  return shapeMapping(updated);
}

async function remove(id) {
  // Read before deleting: the row is the only record of which track it claimed,
  // and without that the track keeps a matchedAt nothing points at and drops
  // out of every bucket on the review page.
  const m = await prisma.songMapping.findUnique({ where: { id } });
  if (!m) throw new NotFoundError('Mapping');

  await prisma.songMapping.delete({ where: { id } }).catch(() => {
    throw new NotFoundError('Mapping');
  });
  await releaseIfUnclaimed(m.source, m.externalId);
  return { id, deleted: true };
}

/**
 * What "不是这首" would destroy, so the reviewer sees it before confirming.
 *
 * The count matters because a pool track is keyed on (source, externalId) and
 * nothing stops two game songs pointing at it — 致青春/王菲 and 致青春/李宇春
 * resolve to different tracks, but a cover and its original may not. Deleting
 * the track breaks every mapping that names it, not just this one.
 */
async function rejectImpact(id) {
  const m = await prisma.songMapping.findUnique({ where: { id } });
  if (!m) throw new NotFoundError('Mapping');

  const track = await prisma.importedTrack.findUnique({
    where: { source_externalId: { source: m.source, externalId: m.externalId } },
  });

  const others = await prisma.songMapping.findMany({
    where: {
      source: m.source,
      externalId: m.externalId,
      id: { not: m.id },
    },
    select: { id: true, rawTitle: true, rawArtist: true, approved: true },
  });

  return {
    mapping: shapeMapping(m),
    // Null when the mapping points at something no longer in the pool: the
    // mapping still goes, there is simply no track left to remove.
    track: track
      ? {
        id: track.id,
        title: track.title,
        artist: track.artist,
        source: track.source,
        externalId: track.externalId,
      }
      : null,
    otherMappings: others.map((o) => ({
      id: o.id,
      title: o.rawTitle,
      artist: o.rawArtist,
      approved: o.approved,
    })),
  };
}

/**
 * "不是这首" — this recording should not be in the catalogue at all.
 *
 * Distinct from picking a different candidate: that repoints a mapping and
 * leaves the pool alone. This removes the track itself, which is what stops
 * the automatic resolver handing it straight back — resolveGameSong builds its
 * candidates from the pool, so a track that is gone cannot be re-chosen, and
 * no blocklist is needed to keep it away.
 *
 * Both deletions happen in one transaction. Half of this is worse than none:
 * a mapping deleted without its track re-resolves to the same track, and a
 * track deleted without its mapping leaves a row pointing at nothing.
 */
async function reject(id, { deleteTrack = true, resolve = true } = {}) {
  const outcome = await prisma.$transaction(async (tx) => {
    // Read inside the transaction. Two reviewers rejecting mappings that share
    // a track will each delete the other's row as an orphan, so a read taken
    // outside can describe something that is already gone by the time the
    // delete runs — which surfaced as a 500 for an operation that had in fact
    // succeeded.
    const m = await tx.songMapping.findUnique({ where: { id } });
    if (!m) return null;

    await tx.songMapping.delete({ where: { id } });

    if (!deleteTrack) {
      return { m, trackDeleted: false, mappingsRemoved: 1 };
    }

    // Every mapping naming this track goes with it, or they would be left
    // resolving to a row that no longer exists.
    const orphaned = await tx.songMapping.deleteMany({
      where: { source: m.source, externalId: m.externalId },
    });
    const gone = await tx.importedTrack.deleteMany({
      where: { source: m.source, externalId: m.externalId },
    });
    return {
      m,
      trackDeleted: gone.count > 0,
      mappingsRemoved: 1 + orphaned.count,
    };
  });

  if (!outcome) throw new NotFoundError('Mapping');

  const { m, ...result } = outcome;

  // With the track gone, ask the resolver what this game song maps to now.
  //
  // Not a courtesy re-match: the mapping was just deleted, so the song is
  // unmapped until something says otherwise, and the next capture would run
  // this same lookup anyway. Doing it here means the caller learns the outcome
  // straight away instead of discovering it the next time the game plays it.
  //
  // It cannot come back with what was just removed — resolveGameSong builds
  // its candidates from the pool, and that row is gone. A remaining recording
  // of the same song is chosen by the ordinary rules, so an exact agreement on
  // title and artist approves itself and anything looser queues for review.
  //
  // Required lazily: mappingResolveService imports nothing from here today,
  // but a top-level require would make that a cycle the moment it did.
  // Failures here are swallowed on purpose. The deletion is already committed
  // and cannot be undone, so letting this throw would report a 500 for work
  // that succeeded — and the caller would press again and get a 404. Two
  // reviewers rejecting the same game song race to create the replacement, and
  // the loser hits the unique constraint on (titleKey, artistKey); that is the
  // winner's row being there already, not a failure of this call.
  //
  // Answering `null` costs nothing either way: the song is simply unmapped
  // until the next capture runs the same lookup.
  let replacement = null;
  if (resolve !== false) {
    const { resolveGameSong } = require('./mappingResolveService');
    try {
      const next = await resolveGameSong({ title: m.rawTitle, artist: m.rawArtist });
      replacement = next.mapping
        ? { ...shapeMapping(next.mapping), status: next.status, tier: next.tier }
        : null;
    } catch {
      replacement = null;
    }
  }

  return {
    id,
    deleted: true,
    source: m.source,
    externalId: m.externalId,
    ...result,
    // The game song's new home, or null when the pool has nothing else to
    // offer — which is the caller's cue to show it as unconfigured.
    replacement,
  };
}

/** Note that a pool entry has been claimed. Idempotent. */
async function markSeen(source, externalId) {
  await prisma.importedTrack.updateMany({
    where: { source, externalId, matchedAt: null },
    data: { matchedAt: new Date() },
  });
}

/**
 * The other half of markSeen: give a track back to 未遇见 once nothing maps it.
 *
 * matchedAt is what the review page counts as coverage, and it was only ever
 * set. Deleting the mapping that claimed a track therefore left the track in no
 * bucket at all — no mapping row to list it under 待确认 or 已确认, and a
 * non-null matchedAt keeping it out of 未遇见. Four tracks were invisible this
 * way before this existed.
 *
 * Checked rather than assumed: two game songs can name the same recording, and
 * the track is still claimed while the other mapping stands.
 */
async function releaseIfUnclaimed(source, externalId) {
  if (!source || !externalId) return;
  const stillMapped = await prisma.songMapping.count({ where: { source, externalId } });
  if (stillMapped > 0) return;
  await prisma.importedTrack.updateMany({
    where: { source, externalId, matchedAt: { not: null } },
    data: { matchedAt: null },
  });
}

/**
 * Create a mapping for a game song against a pool track.
 *
 * This is how an "unseen" row graduates: the reviewer says "the game calls
 * this X" and the pool entry gains a game-side key.
 */
async function createFromTrack({
  gameTitle, gameArtist, source, externalId, userId, approved = true,
}) {
  const tk = titleKey(gameTitle);
  const ak = artistKey(gameArtist);
  if (!tk) throw new ValidationError({ gameTitle: ['游戏侧歌名不能为空'] });

  const track = await prisma.importedTrack.findUnique({
    where: { source_externalId: { source, externalId } },
  });

  const data = {
    titleKey: tk,
    artistKey: ak,
    rawTitle: String(gameTitle).trim(),
    rawArtist: String(gameArtist || '').trim(),
    source,
    externalId,
    platformTitle: track?.title ?? null,
    platformArtist: track?.artist ?? null,
    durationSec: track?.durationSec ?? null,
    origin: 'import',
    matchKind: 'manual',
    approved,
    ...(approved ? { approvedById: userId, approvedAt: new Date() } : {}),
  };

  // What this game song pointed at before, if anything — the upsert below is
  // just as much a repoint as approve() is, and the track it abandons has to
  // be released the same way.
  const previous = await prisma.songMapping.findUnique({
    where: { titleKey_artistKey: { titleKey: tk, artistKey: ak } },
    select: { source: true, externalId: true },
  });

  // Upsert, because the same game song may already have a mapping — the
  // reviewer is repointing it rather than creating a duplicate, and the unique
  // key would reject the insert anyway.
  const saved = await prisma.songMapping.upsert({
    where: { titleKey_artistKey: { titleKey: tk, artistKey: ak } },
    create: data,
    update: data,
    include: { approvedBy: { select: { username: true } } },
  });

  await markSeen(source, externalId);
  if (previous && (previous.source !== source || previous.externalId !== externalId)) {
    await releaseIfUnclaimed(previous.source, previous.externalId);
  }
  return shapeMapping(saved);
}

module.exports = {
  getCounts,
  list,
  get,
  getTrack,
  candidatesFor,
  candidatesForMany,
  approve,
  unapprove,
  remove,
  rejectImpact,
  reject,
  createFromTrack,
  markSeen,
  releaseIfUnclaimed,
  PAGE_SIZE,
};
