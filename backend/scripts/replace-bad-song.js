/**
 * replace-bad-song.js — swap a bad song's audio for a good one and reduce it to
 * a single correct clip, without users losing the song from their playlists.
 *
 * WHY THIS EXISTS
 *   update-bad-songs.js refreshes a song's lyrics and duration, and
 *   regen-clips.js re-cuts clip audio, but both keep the OLD clip start times.
 *   Those starts were chosen on the WRONG audio, so after a replacement they
 *   are arbitrary positions. This script keeps ONE clip at the new song's first
 *   sung line and repoints every playlist entry and like at it, then deletes
 *   the leftovers.
 *
 * THE ORDER MATTERS
 *   playlist_clips.clip_id and likes.clip_id are ON DELETE CASCADE, so deleting
 *   a clip that is still referenced silently deletes the user's playlist entry
 *   and their like. Everything is repointed FIRST, and the delete only runs
 *   after asserting that nothing references the old clips any more.
 *
 * WHAT IS PRESERVED
 *   - the song row and its id
 *   - every playlist entry, with its comment, colorTag, speed, pitch, position
 *   - every like (likes are unique per (playlistId, clipId), not per user)
 *   - tag_events (no FK by design) and capture_events (matched_clip_id SET NULL)
 *
 * PREREQUISITE
 *   The corrected .mp3 and .lrc are already on disk under MP3_BASE_PATH with the
 *   same filename as songs.file_path, and the song row's lyrics/duration have
 *   been refreshed (run update-bad-songs.js first).
 *
 * USAGE
 *   node scripts/replace-bad-song.js --title "歌名" --artist "歌手"
 *   node scripts/replace-bad-song.js --title "歌名" --artist "歌手" --apply
 *   node scripts/replace-bad-song.js --xlsx /home/chaol/bad-songs.xlsx [--apply]
 *   optional: --start <sec> to override the first-lyric position
 *
 * Dry run by default: it prints what each playlist would see and changes nothing.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const prisma = require('../src/db/client');
const config = require('../src/config');
const { createClip } = require('../src/services/clipService');
const { getFirstLyricStart } = require('../src/utils/lrc');

const CLIP_LENGTH = 20;
const LRC_EXT = new RegExp(String.fromCharCode(92) + '.mp3$', 'i');

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => {
    const i = a.indexOf(flag);
    return i !== -1 && a[i + 1] ? a[i + 1] : null;
  };
  const startRaw = get('--start');
  const opts = {
    apply: a.includes('--apply'),
    title: get('--title'),
    artist: get('--artist'),
    xlsx: get('--xlsx'),
    start: startRaw !== null ? parseInt(startRaw, 10) : null,
  };
  if (!opts.xlsx && !(opts.title && opts.artist)) {
    console.error('Error: pass --xlsx <path>, or both --title and --artist');
    process.exit(1);
  }
  return opts;
}

function readTargets(opts) {
  if (!opts.xlsx) return [{ title: opts.title, artist: opts.artist, start: opts.start }];
  if (!fs.existsSync(opts.xlsx)) {
    console.error('Error: file not found: ' + opts.xlsx);
    process.exit(1);
  }
  const wb = XLSX.readFile(opts.xlsx);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  if (!rows.length) { console.error('Error: xlsx is empty'); process.exit(1); }
  if (!('Title' in rows[0]) || !('Artist' in rows[0])) {
    console.error('Error: xlsx needs "Title" and "Artist" columns');
    process.exit(1);
  }
  return rows.map((r) => ({
    title: String(r.Title).trim(),
    artist: String(r.Artist).trim(),
    start: null,
  }));
}

/** Everything that references this song's clips, for the report and the plan. */
async function inspect(song) {
  const clips = await prisma.clip.findMany({
    where: { songId: song.id },
    orderBy: { start: 'asc' },
  });
  const ids = clips.map((c) => c.id);
  const refs = ids.length
    ? await prisma.playlistClip.findMany({
        where: { clipId: { in: ids } },
        include: { playlist: { include: { user: { select: { username: true } } } } },
        orderBy: [{ playlistId: 'asc' }, { position: 'asc' }],
      })
    : [];
  const likes = ids.length
    ? await prisma.like.findMany({
        where: { clipId: { in: ids } },
        include: { user: { select: { username: true } }, playlist: { select: { name: true } } },
      })
    : [];
  return { clips, refs, likes };
}

async function handleSong(target, opts) {
  const where = {
    title: { equals: target.title, mode: 'insensitive' },
    artist: { equals: target.artist, mode: 'insensitive' },
  };
  const matches = await prisma.song.findMany({ where });
  if (!matches.length) return { status: 'not_found' };
  // Two rows for one title+artist means we cannot tell which was meant, and
  // acting on an arbitrary one would leave the other stale.
  if (matches.length > 1) return { status: 'ambiguous', twins: matches.length };
  const song = matches[0];

  const mp3Path = path.join(config.mp3BasePath, song.filePath);
  if (!fs.existsSync(mp3Path)) return { status: 'no_mp3', mp3Path };

  // The new clip starts at the first sung line of the CORRECTED lyrics, unless
  // --start overrides it. Duration rules out a broken tag past the end.
  const autoStart = getFirstLyricStart(song.lyrics, song.duration);
  const newStart = Number.isInteger(target.start) ? target.start : autoStart;
  if (song.duration != null && song.duration > 0 && newStart >= song.duration) {
    return { status: 'start_past_end', newStart };
  }

  const before = await inspect(song);

  console.log('');
  console.log('='.repeat(72));
  console.log(song.title + ' - ' + song.artist);
  console.log('  song id   : ' + song.id);
  console.log('  file      : ' + song.filePath);
  console.log('  duration  : ' + song.duration + 's');
  console.log('  starts    : ' + (song.starts || '(none)'));
  console.log('  new clip  : start=' + newStart + 's len=' + CLIP_LENGTH + 's'
    + (Number.isInteger(target.start) ? '  (--start given)' : '  (first lyric line)'));
  console.log('  lyrics[0] : ' + String(song.lyrics || '').split(/\r?\n/)[0].slice(0, 60));
  console.log('');
  console.log('  existing clips: ' + before.clips.length);
  for (const c of before.clips) {
    const nRef = before.refs.filter((r) => r.clipId === c.id).length;
    const nLike = before.likes.filter((l) => l.clipId === c.id).length;
    const reused = c.start === newStart;
    console.log('    start=' + String(c.start).padStart(4) + 's  refs=' + String(nRef).padStart(3)
      + '  likes=' + nLike + (reused ? '   <= REUSED as the new clip' : '   -> will be deleted'));
  }

  // Group by playlist so the unique-key collision case is visible up front.
  const byPlaylist = new Map();
  for (const r of before.refs) {
    if (!byPlaylist.has(r.playlistId)) byPlaylist.set(r.playlistId, []);
    byPlaylist.get(r.playlistId).push(r);
  }
  const collisions = [...byPlaylist.values()].filter((v) => v.length > 1);

  console.log('');
  console.log('  playlists referencing it: ' + byPlaylist.size
    + '   (entries: ' + before.refs.length + ', likes: ' + before.likes.length + ')');
  if (collisions.length) {
    console.log('  !! ' + collisions.length + ' playlists reference MORE THAN ONE clip of this song.');
    console.log('     (playlistId, clipId) is unique, so only the lowest-position entry');
    console.log('     can point at the new clip; the others are deleted:');
    for (const grp of collisions) {
      const owner = grp[0].playlist.user ? grp[0].playlist.user.username : '?';
      console.log('       [' + grp[0].playlist.name + '] owner=' + owner);
      const sorted = grp.slice().sort((x, y) => x.position - y.position);
      sorted.forEach((r, i) => {
        const c = before.clips.find((x) => x.id === r.clipId);
        console.log('         ' + (i === 0 ? 'KEEP  ' : 'DELETE') + ' pos=' + r.position
          + ' clip@' + (c ? c.start : '?') + 's comment="' + (r.comment || '')
          + '" color=' + (r.colorTag || '-'));
      });
    }
  }

  console.log('');
  console.log('  per-playlist detail:');
  for (const grp of byPlaylist.values()) {
    const r = grp.slice().sort((x, y) => x.position - y.position)[0];
    const owner = r.playlist.user ? r.playlist.user.username : '?';
    const c = before.clips.find((x) => x.id === r.clipId);
    const liked = before.likes.some((l) => l.playlistId === r.playlistId);
    console.log('    ' + String(owner).padEnd(14) + ' [' + r.playlist.name + ']'
      + '  clip@' + (c ? c.start : '?') + 's -> @' + newStart + 's'
      + '  pos=' + r.position + ' speed=' + r.speed + ' pitch=' + r.pitch
      + (r.comment ? ' comment="' + r.comment + '"' : '')
      + (r.colorTag ? ' color=' + r.colorTag : '')
      + (liked ? ' [liked]' : ''));
  }

  if (!opts.apply) {
    console.log('');
    console.log('  DRY RUN - nothing changed.');
    return { status: 'dry_run' };
  }

  // 1. Cut the one good clip. The ADMIN force path re-cuts over an existing
  //    clip at the same start and keeps its id, so a playlist already pointing
  //    there is undisturbed.
  const good = await createClip({
    songId: song.id,
    start: newStart,
    length: CLIP_LENGTH,
    userId: null,
    userRole: 'ADMIN',
    force: true,
  });
  console.log('');
  console.log('  clip ' + good.id + ' @' + good.start + 's v' + good.version);

  const oldIds = before.clips.map((c) => c.id).filter((id) => id !== good.id);

  // 2+3. Repoint playlist entries and likes in one transaction, the way
  //    DELETE /clips/:id does it: a user editing this playlist mid-run must
  //    never observe the song half-moved, and a failure must not leave some
  //    entries on the new clip and some on a clip about to be deleted.
  //    Lowest position first, so the entry the user sees highest is the keeper.
  let repointed = 0, mergedRefs = 0, likesMoved = 0, likesMerged = 0;
  const renumber = new Set();
  // The default transaction timeout is 5s. A heavily shared song can carry
  // hundreds of entries (632 is the current maximum in the library), and each
  // one is a round trip, so the default would roll the whole repoint back.
  await prisma.$transaction(async (tx) => {
    repointed = 0; mergedRefs = 0; likesMoved = 0; likesMerged = 0;
    for (const grp of byPlaylist.values()) {
      const sorted = grp.slice().sort((x, y) => x.position - y.position);
      for (const r of sorted) {
        if (r.clipId === good.id) continue;
        const clash = await tx.playlistClip.findFirst({
          where: { playlistId: r.playlistId, clipId: good.id },
        });
        if (clash) {
          await tx.playlistClip.delete({ where: { id: r.id } });
          mergedRefs++;
          renumber.add(r.playlistId);
        } else {
          await tx.playlistClip.update({ where: { id: r.id }, data: { clipId: good.id } });
          repointed++;
        }
      }
    }
    // Likes are unique on (playlistId, clipId), the same shape as the entries.
    for (const l of before.likes) {
      if (l.clipId === good.id) continue;
      const clash = await tx.like.findFirst({
        where: { playlistId: l.playlistId, clipId: good.id },
      });
      if (clash) {
        await tx.like.delete({ where: { id: l.id } });
        likesMerged++;
      } else {
        await tx.like.update({ where: { id: l.id }, data: { clipId: good.id } });
        likesMoved++;
      }
    }
    // Close the numbering hole a merged-away row left, as the delete route
    // does, so a gap never outlives the change that made it.
    for (const playlistId of renumber) {
      const rows = await tx.playlistClip.findMany({
        where: { playlistId }, orderBy: { position: 'asc' }, select: { id: true, position: true },
      });
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].position !== i) {
          await tx.playlistClip.update({ where: { id: rows[i].id }, data: { position: i } });
        }
      }
    }
  }, { maxWait: 15000, timeout: 120000 });
  console.log('  playlist entries: ' + repointed + ' repointed, ' + mergedRefs + ' merged away');
  console.log('  likes           : ' + likesMoved + ' moved, ' + likesMerged + ' merged away');

  // 4. Refuse to delete while anything still points at the old clips - that is
  //    exactly when CASCADE would take a user playlist entry with it.
  if (oldIds.length) {
    const stillRefs = await prisma.playlistClip.count({ where: { clipId: { in: oldIds } } });
    const stillLikes = await prisma.like.count({ where: { clipId: { in: oldIds } } });
    if (stillRefs || stillLikes) {
      console.error('  ABORT: ' + stillRefs + ' entries and ' + stillLikes
        + ' likes still reference the old clips; deleting would cascade them away.');
      return { status: 'aborted_refs_remain' };
    }
    for (const id of oldIds) {
      const c = await prisma.clip.findUnique({ where: { id } });
      if (c && c.filePath) {
        const f = path.join(config.clipsBasePath, c.filePath);
        try { fs.unlinkSync(f); } catch {}
        try { fs.unlinkSync(f.replace(LRC_EXT, '.lrc')); } catch {}
      }
      await prisma.clip.delete({ where: { id } });
    }
    console.log('  deleted ' + oldIds.length + ' stale clips and their files');
  }

  // 5. songs.starts must describe the clips that actually exist, or the player
  //    offers cut points that are not there.
  const remaining = await prisma.clip.findMany({
    where: { songId: song.id }, select: { start: true }, orderBy: { start: 'asc' },
  });
  // Deduped and sorted, exactly as routes/clips.js rebuilds it on delete:
  // (songId, start) is only an index, not unique, so two clips may share a
  // start and a plain join would write "16|16".
  const starts = [...new Set(remaining.map((c) => c.start))]
    .sort((a, b) => a - b)
    .join('|');
  await prisma.song.update({ where: { id: song.id }, data: { starts: starts || null } });
  console.log('  songs.starts    : "' + (song.starts || '') + '" -> "' + starts + '"');

  // 6. Verify rather than assume.
  const after = await inspect(song);
  const okRefs = after.refs.length === before.refs.length - mergedRefs;
  const okLikes = after.likes.length === before.likes.length - likesMerged;
  const okClips = after.clips.length === 1 && after.clips[0].start === newStart;
  const clipFile = after.clips[0] && after.clips[0].filePath
    ? path.join(config.clipsBasePath, after.clips[0].filePath) : null;
  const okFile = clipFile ? fs.existsSync(clipFile) : false;
  console.log('  verify: entries ' + before.refs.length + '->' + after.refs.length + (okRefs ? ' ok' : ' MISMATCH')
    + ' | likes ' + before.likes.length + '->' + after.likes.length + (okLikes ? ' ok' : ' MISMATCH')
    + ' | clips ' + before.clips.length + '->' + after.clips.length + (okClips ? ' ok' : ' MISMATCH')
    + ' | audio ' + (okFile ? 'on disk' : 'MISSING'));

  return { status: (okRefs && okLikes && okClips && okFile) ? 'updated' : 'verify_failed' };
}

async function main() {
  const opts = parseArgs();
  const targets = readTargets(opts);

  console.log('replace-bad-song: ' + targets.length + ' songs'
    + (opts.apply ? '  [APPLY]' : '  [DRY RUN]'));
  if (!opts.apply) console.log('No changes will be made. Re-run with --apply.');

  const tally = {};
  for (const t of targets) {
    let r;
    try {
      r = await handleSong(t, opts);
    } catch (err) {
      console.error('');
      console.error('  FAILED ' + t.title + ' - ' + t.artist + ' : ' + err.message);
      r = { status: 'failed' };
    }
    tally[r.status] = (tally[r.status] || 0) + 1;
    if (r.status === 'not_found') console.log('  NOT FOUND: ' + t.title + ' - ' + t.artist);
    if (r.status === 'ambiguous') console.log('  AMBIGUOUS (' + r.twins + ' rows): ' + t.title + ' - ' + t.artist);
    if (r.status === 'no_mp3') console.log('  NO MP3 ON DISK: ' + r.mp3Path);
    if (r.status === 'start_past_end') console.log('  START PAST END: ' + t.title + ' start=' + r.newStart);
  }

  console.log('');
  console.log('--- summary ---');
  for (const k of Object.keys(tally)) console.log('  ' + k + ': ' + tally[k]);

  // Nothing in the database may point at a clip that no longer exists.
  const oRefs = await prisma.$queryRawUnsafe(
    'select count(*)::int n from playlist_clips pc left join clips c on c.id = pc.clip_id where c.id is null');
  const oLikes = await prisma.$queryRawUnsafe(
    'select count(*)::int n from likes l left join clips c on c.id = l.clip_id where c.id is null');
  console.log('  db-wide orphans: playlist_clips=' + oRefs[0].n + ' likes=' + oLikes[0].n
    + ((oRefs[0].n || oLikes[0].n) ? '   !! INVESTIGATE' : ''));
}

main()
  .catch((err) => { console.error('Fatal: ' + err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
