/**
 * backfill-songs.js
 *
 * Backfills missing data for existing songs:
 *   1. Pinyin concat columns (title_pinyin_concat, artist_pinyin_concat)
 *   2. Starts field from first LRC lyric timestamp
 *   3. Default clip (audio file + sliced lyrics) if none exists at first start
 *
 * Usage: node scripts/backfill-songs.js [--all]
 *
 * Options:
 *   --all   Process all songs, even those already backfilled
 */

require('dotenv').config();
const path = require('path');
const prisma = require('../src/db/client');
const { toPinyinConcat } = require('../src/utils/pinyin');
const { sliceLRC } = require('../src/utils/lrc');
const { clipAudio } = require('./clip-audio');

const CLIP_LENGTH = 20;

function getFirstLyricStart(lyrics) {
  if (!lyrics) return null;
  const match = lyrics.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
  if (!match) return null;
  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  return minutes * 60 + seconds;
}

function buildClipFilename(title, artist, start) {
  const artists = artist.split('_').map((a) => a.trim()).join(' & ');
  const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '_');
  return `${safe(title)} - ${safe(artists)} - ${start}.mp3`;
}

async function main() {
  const updateAll = process.argv.includes('--all');
  const mp3BasePath = process.env.MP3_BASE_PATH;
  const clipsBasePath = process.env.CLIPS_BASE_PATH;

  // --- 1. Backfill pinyin concat ---
  const concatWhere = updateAll ? {} : { titlePinyinConcat: null };
  const songsForConcat = await prisma.song.findMany({
    where: concatWhere,
    select: { id: true, title: true, artist: true },
  });

  console.log(`Backfilling pinyin concat for ${songsForConcat.length} songs...`);
  for (const song of songsForConcat) {
    await prisma.song.update({
      where: { id: song.id },
      data: {
        titlePinyinConcat: toPinyinConcat(song.title),
        artistPinyinConcat: toPinyinConcat(song.artist),
      },
    });
  }

  const artistsForConcat = await prisma.songArtist.findMany({
    where: updateAll ? {} : { artistPinyinConcat: null },
    select: { id: true, artistName: true },
  });

  console.log(`Backfilling pinyin concat for ${artistsForConcat.length} song artists...`);
  for (const a of artistsForConcat) {
    await prisma.songArtist.update({
      where: { id: a.id },
      data: { artistPinyinConcat: toPinyinConcat(a.artistName) },
    });
  }

  // --- 2. Backfill starts + default clips ---
  const startsWhere = updateAll
    ? { lyrics: { not: null } }
    : { lyrics: { not: null }, starts: null };

  const songsForStarts = await prisma.song.findMany({
    where: startsWhere,
    select: { id: true, title: true, artist: true, filePath: true, lyrics: true, starts: true },
  });

  console.log(`Processing starts + clips for ${songsForStarts.length} songs...`);

  let updatedStarts = 0;
  let clipsCreated = 0;

  for (const song of songsForStarts) {
    const firstStart = getFirstLyricStart(song.lyrics);
    if (firstStart === null) continue;

    // Update starts field
    const newStarts = updateAll && song.starts
      ? [...new Set([firstStart, ...song.starts.split('|').map(Number)])]
          .sort((a, b) => a - b)
          .join('|')
      : String(firstStart);

    await prisma.song.update({
      where: { id: song.id },
      data: { starts: newStarts },
    });
    updatedStarts++;

    // Create clip if one doesn't exist at this start time
    const existing = await prisma.clip.findFirst({
      where: { songId: song.id, start: firstStart },
    });

    if (!existing) {
      const clipLyrics = sliceLRC(song.lyrics, firstStart, firstStart + CLIP_LENGTH);
      const clipFilename = buildClipFilename(song.title, song.artist, firstStart);
      const sourcePath = path.join(mp3BasePath, song.filePath);
      const outputPath = path.join(clipsBasePath, clipFilename);

      try {
        clipAudio({ sourcePath, outputPath, start: firstStart, length: CLIP_LENGTH, lyrics: clipLyrics });

        await prisma.clip.create({
          data: {
            songId: song.id,
            start: firstStart,
            length: CLIP_LENGTH,
            filePath: clipFilename,
            lyrics: clipLyrics,
          },
        });
        clipsCreated++;
      } catch (err) {
        console.warn(`  Warning: Could not create clip for "${song.title}" at ${firstStart}s: ${err.message}`);
      }
    }
  }

  console.log('\n--- Backfill complete ---');
  console.log(`  Pinyin concat: ${songsForConcat.length} songs, ${artistsForConcat.length} artists`);
  console.log(`  Starts updated: ${updatedStarts}`);
  console.log(`  Clips created: ${clipsCreated}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
