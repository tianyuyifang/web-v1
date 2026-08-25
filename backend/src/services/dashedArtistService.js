/**
 * The hand-kept half of the dashed-artist list.
 *
 * Splitting "歌名-歌手" happens at a dash, so a dash inside the artist's own
 * name is the one thing that can break it. Nearly every such name is already in
 * imported_tracks and is found there automatically; this table holds the ones
 * that are not, which in practice means the game credits a group where the
 * platform credits the member.
 *
 * One member per row. A single member carrying the dash is enough to decide
 * where the dash belongs, so "IN-K" covers every pairing IN-K will ever appear
 * in, in any order — and storing "王忻辰/IN-K" instead would need a new row for
 * every future collaborator, in both orders, forever.
 */
const prisma = require('../db/client');
const { AppError } = require('../utils/errors');
const { invalidateDashedArtists, loadDashedArtists } = require('./captureService');

const DASH = /[-–—]/;

/** Both halves of the list, so the editor can show what it cannot change. */
async function list() {
  const manual = await prisma.dashedArtist.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, note: true, createdAt: true },
  });

  // What the catalogue supplies on its own. Shown read-only: deleting one would
  // achieve nothing, since the next refresh reads it straight back out of
  // imported_tracks.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT artist FROM imported_tracks
      WHERE artist LIKE '%-%' OR artist LIKE '%–%' OR artist LIKE '%—%'
      ORDER BY artist`
  );
  const derived = [];
  const seen = new Set(manual.map((m) => m.name));
  for (const r of rows) {
    for (const part of String(r.artist || '').split('/')) {
      const p = part.trim().toLowerCase();
      if (p && DASH.test(p) && !seen.has(p)) { seen.add(p); derived.push(p); }
    }
  }

  return { manual, derived: derived.sort(), total: manual.length + derived.length };
}

/**
 * Add one name.
 *
 * Three refusals, all of them for the same reason: a name that cannot affect a
 * split is worse than useless here, because it makes the list longer without
 * making it truer, and the next person to read it has to work out why it is
 * there.
 */
async function add({ name, note, userId }) {
  const clean = String(name || '').trim().toLowerCase();

  if (!clean) {
    throw new AppError('请输入歌手名', 400);
  }
  if (!DASH.test(clean)) {
    throw new AppError('只需要添加名字里带横杠的歌手 — 不带横杠的名字不会影响切分', 400);
  }
  if (clean.includes('/')) {
    throw new AppError('合作歌手请分开添加，只填带横杠的那一位（例如 IN-K）', 400);
  }

  // Already derivable from the catalogue, so adding it changes nothing.
  const known = await loadDashedArtists();
  if (known.has(clean)) {
    const existing = await prisma.dashedArtist.findUnique({ where: { name: clean } });
    if (!existing) {
      throw new AppError('曲库里已经有这个歌手了，不用手动添加', 409);
    }
    throw new AppError('这个歌手已经在列表里了', 409);
  }

  const row = await prisma.dashedArtist.create({
    data: { name: clean, note: note || null, createdBy: userId || null },
  });
  // So the next split sees it, rather than up to ten minutes later.
  invalidateDashedArtists();
  return { artist: row };
}

/** Remove a hand-added name. Derived ones have no row and cannot be removed. */
async function remove(id) {
  const row = await prisma.dashedArtist.findUnique({ where: { id } });
  if (!row) {
    throw new AppError('没有找到这条记录', 404);
  }
  await prisma.dashedArtist.delete({ where: { id } });
  invalidateDashedArtists();
  return { removed: row.name };
}

module.exports = { list, add, remove };
