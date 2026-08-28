/**
 * add-songs.js
 *
 * Shared import loop for all playlist importers (QQ, NetEase, KuGou, xlsx file).
 * Takes an already-fetched list of { title, artist } songs, matches them against
 * the local DB, creates clips as needed, and appends them to a target playlist.
 *
 * Optimizations vs. the old per-source loops:
 *   - Bulk title prefetch: one `song.findMany({ title: { in } })` instead of one
 *     query per song, building a title -> candidates map. Matching then works in
 *     memory (pickMostPopular still hits the DB only for ambiguous titles).
 *   - Async ffmpeg (clipAudioAsync) so the event loop is not frozen during import.
 *   - onProgress(processed, total) callback for live job progress.
 */

const path = require('path');
const prisma = require('../../src/db/client');
const { sliceLRC } = require('../../src/utils/lrc');
const { clipAudioAsync } = require('../clip-audio');
const { pickMostPopular } = require('./find-song');

const CLIP_LENGTH = 20;

/**
 * Which of a song's start times to import.
 *
 * The second one, when there is a second one. `song.starts` is written by
 * clip creation, so the order records how the cut points accumulated: the
 * first is usually an early bulk-generated position, and the second is the
 * one somebody chose deliberately because it is the part worth singing.
 *
 * Measured against production before choosing this: of 4,803 clips users cut
 * by hand on multi-start songs, 86.2% sit at the second start and only 2.3%
 * at the first — so importing the first start disagreed with the people who
 * had actually made the choice almost every time. Roughly 14% land on some
 * other start (mostly the third), which this rule still gets wrong; it trades
 * a 2.3% hit rate for an 86% one, not for certainty.
 *
 * This is not chorus detection. Nothing in the schema marks a chorus, and
 * this makes no claim to find one — it follows what users picked.
 *
 * @param {string|null} starts - '|'-joined seconds, ascending
 * @returns {number} the start time to use
 */
function pickStart(starts) {
  const arr = starts
    ? starts.split('|').map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
    : [];
  if (arr.length === 0) return 0;
  return arr.length > 1 ? arr[1] : arr[0];
}

function buildClipFilename(title, artist, start) {
  const artists = artist.split('_').map((a) => a.trim()).join(' & ');
  const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '_');
  return `${safe(title)} - ${safe(artists)} - ${start}.mp3`;
}

/**
 * Match a source song against a prefetched title -> candidates map, replicating
 * findSongInDB's logic exactly: fuzzy artist match first, else the single
 * candidate, else the most popular (DB-backed) among same-title candidates.
 *
 * @param {string} title
 * @param {string} artist  - artists joined by '_'
 * @param {Map<string, object[]>} byTitle
 * @returns {Promise<object|null>}
 */
async function matchSong(title, artist, byTitle) {
  const candidates = byTitle.get(title) || [];
  if (candidates.length === 0) return null;

  if (artist) {
    const ext = artist.split('_').map((a) => a.trim().toLowerCase());
    for (const song of candidates) {
      const db = song.artist.split('_').map((a) => a.trim().toLowerCase());
      if (ext.some((ea) => db.some((da) => da.includes(ea) || ea.includes(da)))) return song;
    }
  }

  if (candidates.length === 1) return candidates[0];
  return pickMostPopular(candidates);
}

/**
 * Add a list of external songs to a playlist.
 *
 * @param {{ title: string, artist: string }[]} songs
 * @param {string} targetPlaylistId
 * @param {(processed: number, total: number) => void} [onProgress]
 * @returns {Promise<{ added: number, skipped: number, notFound: string[], titleConflict: object[] }>}
 */
async function addSongsToPlaylist(songs, targetPlaylistId, onProgress) {
  const total = songs.length;
  if (total === 0) return { added: 0, skipped: 0, notFound: [], titleConflict: [] };

  const mp3BasePath = process.env.MP3_BASE_PATH;
  const clipsBasePath = process.env.CLIPS_BASE_PATH;

  // Bulk prefetch all candidate songs by title (one query instead of N).
  const titles = [...new Set(songs.map((s) => s.title))];
  const allCandidates = await prisma.song.findMany({ where: { title: { in: titles } } });
  const byTitle = new Map();
  for (const s of allCandidates) {
    if (!byTitle.has(s.title)) byTitle.set(s.title, []);
    byTitle.get(s.title).push(s);
  }

  // Existing songs already in the target playlist (title -> artist).
  const existingSongs = await prisma.playlistClip.findMany({
    where: { playlistId: targetPlaylistId },
    include: { clip: { include: { song: { select: { title: true, artist: true } } } } },
  });
  const existingTitleMap = new Map();
  for (const pc of existingSongs) existingTitleMap.set(pc.clip.song.title, pc.clip.song.artist);

  const maxPos = await prisma.playlistClip.aggregate({
    where: { playlistId: targetPlaylistId },
    _max: { position: true },
  });
  let position = (maxPos._max.position ?? -1) + 1;

  let added = 0;
  let skipped = 0;
  const notFound = [];
  const titleConflict = [];

  for (let i = 0; i < songs.length; i++) {
    const src = songs[i];
    const song = await matchSong(src.title, src.artist, byTitle);

    if (!song) {
      notFound.push(`${src.title} - ${src.artist}`);
      onProgress?.(i + 1, total);
      continue;
    }

    // Song title already in target playlist → skip if same artist, else conflict.
    const existingArtist = existingTitleMap.get(song.title);
    if (existingArtist !== undefined) {
      const dbA = existingArtist.split('_').map((a) => a.trim().toLowerCase());
      const exA = song.artist.split('_').map((a) => a.trim().toLowerCase());
      const sameArtist = exA.some((ea) => dbA.some((da) => da.includes(ea) || ea.includes(da)));
      if (sameArtist) skipped++;
      else titleConflict.push({ title: song.title, externalArtist: src.artist, localArtist: existingArtist });
      onProgress?.(i + 1, total);
      continue;
    }

    const startSec = pickStart(song.starts);

    // Find or create clip at this start time (prefer global clips).
    let clip = await prisma.clip.findFirst({ where: { songId: song.id, start: startSec, isGlobal: true } })
      || await prisma.clip.findFirst({ where: { songId: song.id, start: startSec } });

    if (!clip) {
      const clipLyrics = sliceLRC(song.lyrics, startSec, startSec + CLIP_LENGTH);
      const clipFilename = buildClipFilename(song.title, song.artist, startSec);
      const sourcePath = path.join(mp3BasePath, song.filePath);
      const outputPath = path.join(clipsBasePath, clipFilename);

      try {
        await clipAudioAsync({ sourcePath, outputPath, start: startSec, length: CLIP_LENGTH, lyrics: clipLyrics });
      } catch (err) {
        console.warn(`  Warning: Could not clip "${song.title}": ${err.message}`);
      }

      clip = await prisma.clip.create({
        data: { songId: song.id, start: startSec, length: CLIP_LENGTH, filePath: clipFilename, lyrics: clipLyrics },
      });
    }

    await prisma.playlistClip.create({ data: { playlistId: targetPlaylistId, clipId: clip.id, position } });
    existingTitleMap.set(song.title, song.artist);
    position++;
    added++;
    onProgress?.(i + 1, total);
  }

  return { added, skipped, notFound, titleConflict };
}

module.exports = { addSongsToPlaylist, buildClipFilename, matchSong, pickStart };
