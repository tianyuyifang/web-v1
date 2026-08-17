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

  return {
    bucket,
    rows: rows.slice(0, limit).map(shapeMapping),
    nextCursor: hasMore ? rows[limit - 1].id : null,
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
    take: 25,
  });

  return sameTitle
    .map((t) => ({
      source: t.source,
      externalId: t.externalId,
      title: t.title,
      artist: t.artist,
      durationSec: t.durationSec,
      album: t.album,
      vipOnly: t.vipOnly,
      // Ranked, not filtered: the game and the platform disagree about artists
      // often enough that dropping the non-overlapping ones would hide the
      // right answer.
      artistMatches: artistsOverlap(m.rawArtist, t.artist),
      durationMatches: m.durationSec != null && t.durationSec != null
        && Math.abs(m.durationSec - t.durationSec) <= 3,
      current: t.externalId === m.externalId,
    }))
    .sort((a, b) => (Number(b.artistMatches) - Number(a.artistMatches))
      || (Number(b.durationMatches) - Number(a.durationMatches)));
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
  await prisma.songMapping.delete({ where: { id } }).catch(() => {
    throw new NotFoundError('Mapping');
  });
  return { id, deleted: true };
}

/** Note that a pool entry has been claimed. Idempotent. */
async function markSeen(source, externalId) {
  await prisma.importedTrack.updateMany({
    where: { source, externalId, matchedAt: null },
    data: { matchedAt: new Date() },
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
  return shapeMapping(saved);
}

module.exports = {
  getCounts,
  list,
  get,
  candidatesFor,
  approve,
  unapprove,
  remove,
  createFromTrack,
  markSeen,
  PAGE_SIZE,
};
