/**
 * Backfill pinyin_all columns for existing songs, song_artists, and playlists.
 * Generates all possible pinyin readings for polyphonic characters.
 *
 * Usage: cd backend && node scripts/backfill-pinyin-all.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { toPinyinAll } = require('../src/utils/pinyin');

const prisma = new PrismaClient();

async function main() {
  // --- Songs ---
  const songs = await prisma.song.findMany({
    select: { id: true, title: true, artist: true },
  });
  console.log(`Backfilling ${songs.length} songs...`);

  let songCount = 0;
  for (const song of songs) {
    await prisma.song.update({
      where: { id: song.id },
      data: {
        titlePinyinAll: toPinyinAll(song.title),
        artistPinyinAll: toPinyinAll(song.artist),
      },
    });
    songCount++;
    if (songCount % 500 === 0) console.log(`  Songs: ${songCount}/${songs.length}`);
  }
  console.log(`  Songs: ${songCount}/${songs.length} done`);

  // --- Song Artists ---
  const songArtists = await prisma.songArtist.findMany({
    select: { id: true, artistName: true },
  });
  console.log(`Backfilling ${songArtists.length} song artists...`);

  let saCount = 0;
  for (const sa of songArtists) {
    await prisma.songArtist.update({
      where: { id: sa.id },
      data: {
        artistPinyinAll: toPinyinAll(sa.artistName),
      },
    });
    saCount++;
    if (saCount % 500 === 0) console.log(`  Song artists: ${saCount}/${songArtists.length}`);
  }
  console.log(`  Song artists: ${saCount}/${songArtists.length} done`);

  // --- Playlists ---
  const playlists = await prisma.playlist.findMany({
    select: { id: true, name: true },
  });
  console.log(`Backfilling ${playlists.length} playlists...`);

  for (const pl of playlists) {
    await prisma.playlist.update({
      where: { id: pl.id },
      data: {
        namePinyinAll: toPinyinAll(pl.name),
      },
    });
  }
  console.log(`  Playlists: ${playlists.length} done`);

  console.log('\nBackfill complete.');
}

main()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
