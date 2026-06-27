const prisma = require('../db/client');
const { NotFoundError, ForbiddenError } = require('../utils/errors');
const { toPinyin, toPinyinInitials, toPinyinAll } = require('../utils/pinyin');

const ANNOTATION_DIFFERENT_CLIP = '[B 中的片段不同]';
const ANNOTATION_MULTIPLE_DIFFERENT_CLIPS = '[B 中存在多个不同片段]';
const ANNOTATION_DELETED = '[此歌已删]';
const ANNOTATION_CLIP_FROM_B = '[已采用 B 的片段]';

const DEFAULT_MERGE_OPTIONS = Object.freeze({
  speed: 'B',
  pitch: 'A',
  comment: 'A',
  colorTag: 'combine',
  sectionLabel: 'B',
  clipCut: 'A',
  order: 'B',
});

function normalizeOptions(options) {
  return { ...DEFAULT_MERGE_OPTIONS, ...(options || {}) };
}

function pick(opt, aVal, bVal, combiner) {
  if (opt === 'A') return aVal;
  if (opt === 'B') return bVal;
  return combiner ? combiner(aVal, bVal) : bVal;
}

function combineComment(a, b) {
  const lines = [];
  for (const v of [a, b]) {
    if (v === null || v === undefined || v === '') continue;
    if (!lines.includes(v)) lines.push(v);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Append an annotation line to an existing comment.
 *   - if existing is empty/null, return just the annotation
 *   - else return existing + "\n" + annotation
 */
function appendAnnotation(existing, annotation) {
  if (existing === null || existing === undefined || existing === '') {
    return annotation;
  }
  return `${existing}\n${annotation}`;
}

/**
 * Union of two pipe-separated color tag strings.
 * "red|blue" + "blue|green" => "red|blue|green"
 * Returns null if both empty.
 */
function unionColorTags(a, b) {
  const parse = (s) => (s ? s.split('|').filter(Boolean) : []);
  const seen = new Set();
  const out = [];
  for (const c of [...parse(a), ...parse(b)]) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.length > 0 ? out.join('|') : null;
}

/**
 * Compute merge result rows.
 *
 * aClips, bClips: arrays of playlistClip rows from prisma.playlistClip.findMany,
 *   each including clip.{id, songId} (the `clip` field already nests these).
 *   Sorted by position asc.
 *
 * Returns: { rows, summary } where
 *   rows is an array of { clipId, speed, pitch, colorTag, comment, sectionLabel },
 *     ready to be written as playlistClip rows in order.
 *   summary is { added, merged, markedDifferent, markedDeleted } for the API response.
 */
function buildMergeRows(aClips, bClips, options) {
  const opts = normalizeOptions(options);
  // Index A by songId -> ordered list of A clips for that song
  const aBySongId = new Map();
  for (const pc of aClips) {
    const sid = pc.clip.songId;
    if (!aBySongId.has(sid)) aBySongId.set(sid, []);
    aBySongId.get(sid).push(pc);
  }

  // Index A by clip.id for fast Rule-4 lookup
  const aByClipId = new Map();
  for (const pc of aClips) aByClipId.set(pc.clipId, pc);

  // Track which A playlistClips were consumed (so Rule 5 only emits leftovers)
  const consumedA = new Set();

  // Track Rule-2 first-encounter A clip per songId, so subsequent B clips of the
  // same song with different clip.id can append the "multiple different" line
  // to the already-emitted row (not emit a new row).
  // Map of songId -> index into `rows` array.
  const rule2FirstIndexBySong = new Map();

  const rows = [];
  let added = 0, merged = 0, markedDifferent = 0, markedDeleted = 0;

  for (const bPc of bClips) {
    const sid = bPc.clip.songId;
    const aMatches = aBySongId.get(sid) || [];
    const aByExactClip = aByClipId.get(bPc.clipId);

    // Rule 1: no A clip of this song at all
    if (aMatches.length === 0) {
      rows.push({
        clipId: bPc.clipId,
        speed: bPc.speed,
        pitch: bPc.pitch,
        colorTag: bPc.colorTag,
        comment: bPc.comment,
        sectionLabel: bPc.sectionLabel,
      });
      added++;
      continue;
    }

    // Rule 4: same clip.id in both
    if (aByExactClip && !consumedA.has(aByExactClip.clipId)) {
      rows.push({
        clipId: aByExactClip.clipId,
        speed: pick(opts.speed, aByExactClip.speed, bPc.speed),
        pitch: pick(opts.pitch, aByExactClip.pitch, bPc.pitch),
        colorTag: pick(opts.colorTag, aByExactClip.colorTag, bPc.colorTag, unionColorTags),
        comment: pick(opts.comment, aByExactClip.comment, bPc.comment, combineComment),
        sectionLabel: pick(opts.sectionLabel, aByExactClip.sectionLabel, bPc.sectionLabel),
      });
      consumedA.add(aByExactClip.clipId);
      merged++;
      continue;
    }

    // Rule 2: same songId, different clip.id
    if (rule2FirstIndexBySong.has(sid)) {
      // Subsequent B clip of same song with different clip.id -> append the
      // "multiple different" annotation to the already-emitted row (only once).
      const idx = rule2FirstIndexBySong.get(sid);
      const row = rows[idx];
      if (!row.comment || !row.comment.includes(ANNOTATION_MULTIPLE_DIFFERENT_CLIPS)) {
        row.comment = appendAnnotation(row.comment, ANNOTATION_MULTIPLE_DIFFERENT_CLIPS);
      }
      continue;
    }

    // First encounter for this songId in B with different clip.id.
    const aPick = aMatches.find((aPc) => !consumedA.has(aPc.clipId));
    if (!aPick) {
      // All A clips of this song already consumed. Skip.
      continue;
    }

    if (opts.clipCut === 'B') {
      // Adopt B's clip cut; resolve fields via options against the matched A clip,
      // then annotate that the cut was swapped to B's.
      const resolvedComment = pick(opts.comment, aPick.comment, bPc.comment, combineComment);
      rows.push({
        clipId: bPc.clipId,
        speed: pick(opts.speed, aPick.speed, bPc.speed),
        pitch: pick(opts.pitch, aPick.pitch, bPc.pitch),
        colorTag: pick(opts.colorTag, aPick.colorTag, bPc.colorTag, unionColorTags),
        comment: appendAnnotation(resolvedComment, ANNOTATION_CLIP_FROM_B),
        sectionLabel: pick(opts.sectionLabel, aPick.sectionLabel, bPc.sectionLabel),
      });
      consumedA.add(aPick.clipId);
      markedDifferent++;
      continue;
    }

    // clipCut === 'A' (default): keep A's clip, flag it.
    const newComment = appendAnnotation(aPick.comment, ANNOTATION_DIFFERENT_CLIP);
    rows.push({
      clipId: aPick.clipId,
      speed: aPick.speed,
      pitch: aPick.pitch,
      colorTag: aPick.colorTag,
      comment: newComment,
      sectionLabel: aPick.sectionLabel,
    });
    consumedA.add(aPick.clipId);
    rule2FirstIndexBySong.set(sid, rows.length - 1);
    markedDifferent++;
  }

  // Rule 5: A clips not consumed -> append at bottom in A's original order
  for (const aPc of aClips) {
    if (consumedA.has(aPc.clipId)) continue;
    rows.push({
      clipId: aPc.clipId,
      speed: aPc.speed,
      pitch: aPc.pitch,
      colorTag: aPc.colorTag,
      comment: appendAnnotation(aPc.comment, ANNOTATION_DELETED),
      sectionLabel: aPc.sectionLabel,
    });
    markedDeleted++;
  }

  return {
    rows,
    summary: { added, merged, markedDifferent, markedDeleted },
  };
}

/**
 * Top-level merge orchestrator.
 * Loads A and B, checks permissions, runs buildMergeRows, writes the new playlist.
 *
 * Returns: { id, name, summary }.
 * Throws: ForbiddenError (caller does not own A), NotFoundError (B not viewable).
 */
async function mergePlaylists(callerId, aId, bId) {
  const [aPl, bPl] = await Promise.all([
    prisma.playlist.findUnique({ where: { id: aId } }),
    prisma.playlist.findUnique({
      where: { id: bId },
      include: {
        copyPermissions: { where: { userId: callerId }, select: { id: true }, take: 1 },
      },
    }),
  ]);

  if (!aPl) throw new NotFoundError('Playlist');
  if (aPl.userId !== callerId) {
    throw new ForbiddenError('You must own the baseline playlist');
  }

  if (!bPl) throw new NotFoundError('Playlist');
  const bCanView =
    bPl.userId === callerId || bPl.isPublic || bPl.copyPermissions.length > 0;
  if (!bCanView) throw new NotFoundError('Playlist');

  const [aClips, bClips] = await Promise.all([
    prisma.playlistClip.findMany({
      where: { playlistId: aId },
      orderBy: { position: 'asc' },
      include: { clip: { select: { id: true, songId: true } } },
    }),
    prisma.playlistClip.findMany({
      where: { playlistId: bId },
      orderBy: { position: 'asc' },
      include: { clip: { select: { id: true, songId: true } } },
    }),
  ]);

  const { rows, summary } = buildMergeRows(aClips, bClips);

  const newName = `更新版 ${aPl.name}`;
  const newPlaylist = await prisma.playlist.create({
    data: {
      userId: callerId,
      name: newName,
      description: aPl.description,
      isPublic: false,
      namePinyin: toPinyin(newName),
      namePinyinInitials: toPinyinInitials(newName),
      namePinyinAll: toPinyinAll(newName),
      playlistClips: {
        create: rows.map((r, idx) => ({
          clipId: r.clipId,
          position: idx,
          speed: r.speed,
          pitch: r.pitch,
          colorTag: r.colorTag,
          comment: r.comment,
          sectionLabel: r.sectionLabel,
        })),
      },
    },
  });

  return { id: newPlaylist.id, name: newPlaylist.name, summary };
}

module.exports = {
  mergePlaylists, buildMergeRows, unionColorTags, appendAnnotation,
  DEFAULT_MERGE_OPTIONS, normalizeOptions, pick, combineComment,
};
