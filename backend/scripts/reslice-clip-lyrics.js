/**
 * Re-cut the stored lyrics of clips that the old slicer cut wrongly.
 *
 * Before 2026-10-27, src/utils/lrc.js read only the first time tag of a line.
 * Two kinds of song lyrics came out wrong:
 *   - stacked tags, one line sung several times: "[00:41.20][01:52.80]我爱你"
 *     -- a repeat inside the clip was missing, and the extra tags were kept as
 *     lyric text with the song's absolute time in them;
 *   - one fraction digit, "[01:16.0]" -- the line was dropped.
 * A clip's lyrics are cut once, when the clip is made, and stored, so fixing
 * the slicer does not fix clips that already exist. This does, once.
 *
 * Only a clip whose stored lyrics are exactly what the OLD slicer makes from
 * the song's current lyrics is touched: anything that differs (edited by hand,
 * or cut from older lyrics) is listed and left alone. And only songs whose
 * lyrics actually contain one of the two kinds above.
 *
 * Writes, per clip: the new lyrics, version + 1 (the browser caches clip
 * lyrics for 30 days keyed by version, see playlists.js /:id/lyrics -- the
 * same bump an admin's regenerate makes; the audio is the same file and is
 * not touched), and the .lrc file beside the clip mp3 when there is one.
 * Everything it overwrites goes to backups/ first.
 *
 *   node scripts/reslice-clip-lyrics.js           # dry run: what would change
 *   node scripts/reslice-clip-lyrics.js --apply   # write (idempotent)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');
const config = require('../src/config');
const { sliceLRC } = require('../src/utils/lrc');

const APPLY = process.argv.includes('--apply');
const STACKED = /^\[\d{2}:\d{2}\.\d{1,3}\]\[\d{2}:\d{2}\.\d{1,3}\]/m;
const ONE_DECIMAL = /^(\[\d{2}:\d{2}\.\d{1,3}\])*\[\d{2}:\d{2}\.\d\]/m;

/** The slicer exactly as it was before 2026-10-27 -- the safety check. */
function oldSliceLRC(lrcString, startSec, endSec) {
  if (!lrcString) return null;
  const lines = lrcString.split(/\r?\n/);
  const parsed = [];
  for (const line of lines) {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/);
    if (!match) continue;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, '0'), 10);
    const timeSec = minutes * 60 + seconds + ms / 1000;
    parsed.push({ timeSec, text: match[4], raw: line });
  }
  if (parsed.length === 0) {
    const rawLines = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('['));
    return rawLines.length > 0 ? rawLines.join('\n') : null;
  }
  parsed.sort((a, b) => a.timeSec - b.timeSec);
  let firstIdx = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i].timeSec <= startSec) { firstIdx = i; break; }
  }
  let lastIdx = parsed.length - 1;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].timeSec >= endSec) { lastIdx = i; break; }
  }
  const selected = parsed.slice(firstIdx, lastIdx + 1);
  if (selected.length === 0) return null;
  return selected.map((entry) => {
    const adjusted = Math.max(0, entry.timeSec - startSec);
    const min = Math.floor(adjusted / 60);
    const sec = adjusted % 60;
    const secWhole = Math.floor(sec);
    const msec = Math.round((sec - secWhole) * 100);
    return `[${String(min).padStart(2, '0')}:${String(secWhole).padStart(2, '0')}.${String(msec).padStart(2, '0')}]${entry.text}`;
  }).join('\n');
}

function lineDiff(a, b) {
  const A = (a || '').split('\n'), B = (b || '').split('\n');
  const setA = new Set(A), setB = new Set(B);
  return { removed: A.filter((l) => !setB.has(l)), added: B.filter((l) => !setA.has(l)) };
}

(async () => {
  const songs = (await prisma.song.findMany({
    where: { lyrics: { not: null } },
    select: { id: true, title: true, artist: true, lyrics: true },
  })).filter((s) => STACKED.test(s.lyrics) || ONE_DECIMAL.test(s.lyrics));
  const songById = new Map(songs.map((s) => [s.id, s]));
  const clips = await prisma.clip.findMany({
    where: { songId: { in: songs.map((s) => s.id) } },
    select: { id: true, songId: true, start: true, length: true, lyrics: true, version: true, filePath: true },
    orderBy: [{ songId: 'asc' }, { start: 'asc' }],
  });
  console.log(`songs with stacked / one-decimal tags: ${songs.length}; their clips: ${clips.length}`);

  const todo = [];
  const leftAlone = [];
  for (const c of clips) {
    const song = songById.get(c.songId);
    const end = c.start + c.length;
    const next = sliceLRC(song.lyrics, c.start, end);
    if ((c.lyrics ?? null) === (next ?? null)) continue; // already right
    const old = oldSliceLRC(song.lyrics, c.start, end);
    if ((c.lyrics ?? null) !== (old ?? null)) { leftAlone.push({ c, song }); continue; }
    todo.push({ c, song, next });
  }

  console.log(`to re-cut: ${todo.length}; differ from the old slicer's output, left alone: ${leftAlone.length}\n`);
  for (const { c, song, next } of todo) {
    const d = lineDiff(c.lyrics, next);
    console.log(`${song.title} — ${song.artist}  @${c.start}s  clip ${c.id}`);
    for (const l of d.removed) console.log(`   - ${l}`);
    for (const l of d.added) console.log(`   + ${l}`);
  }
  for (const { c, song } of leftAlone) console.log(`LEFT ALONE (stored lyrics are not the old slicer's): ${song.title} @${c.start}s clip ${c.id}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    await prisma.$disconnect();
    return;
  }
  if (!todo.length) { console.log('Nothing to do.'); await prisma.$disconnect(); return; }

  const lrcPathOf = (c) => (c.filePath && config.clipsBasePath
    ? path.join(config.clipsBasePath, c.filePath).replace(/\.mp3$/i, '.lrc') : null);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = path.join(__dirname, `../backups/reslice-clip-lyrics-${stamp}.json`);
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify(todo.map(({ c }) => {
    const lrcPath = lrcPathOf(c);
    return {
      id: c.id, version: c.version, lyrics: c.lyrics, lrcPath,
      lrcFile: lrcPath && fs.existsSync(lrcPath) ? fs.readFileSync(lrcPath, 'utf8') : null,
    };
  }), null, 2), 'utf8');
  console.log(`\nbacked up to ${dump}`);

  let written = 0, lrcWritten = 0;
  for (const { c, next } of todo) {
    // Guarded on the values just read: a clip regenerated meanwhile is skipped.
    const r = await prisma.clip.updateMany({
      where: { id: c.id, version: c.version, lyrics: c.lyrics },
      data: { lyrics: next, version: { increment: 1 } },
    });
    if (r.count !== 1) { console.log(`skipped (changed meanwhile): ${c.id}`); continue; }
    written++;
    const lrcPath = lrcPathOf(c);
    if (lrcPath && fs.existsSync(lrcPath) && next) { fs.writeFileSync(lrcPath, next, 'utf-8'); lrcWritten++; }
  }
  console.log(`re-cut ${written} clips (version +1), rewrote ${lrcWritten} .lrc files`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FAILED:', String(e.message || e).slice(0, 300));
  await prisma.$disconnect();
  process.exit(1);
});
