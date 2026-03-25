/**
 * test-qq-import.js
 *
 * Test script for importing a QQ Music playlist by ID.
 *
 * Flow:
 *   1. Call qq-playlist.py (Selenium) to scrape the QQ Music playlist
 *   2. Match songs against local database by title + artist
 *   3. Report matches and missing songs
 *
 * Usage: node scripts/test-qq-import.js <qqPlaylistId>
 *
 * Requires: Python 3 + selenium + Chrome/ChromeDriver
 */

require('dotenv').config();
const { execFile } = require('child_process');
const path = require('path');
const prisma = require('../src/db/client');

// ------------------------------------------------------------
// Step 1: Fetch QQ Music playlist via Python/Selenium
// ------------------------------------------------------------

function fetchQQPlaylist(playlistId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'qq-playlist.py');

    console.log(`Fetching QQ Music playlist: ${playlistId}`);
    console.log('Running Python scraper...\n');

    execFile('python', ['-u', scriptPath, playlistId], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`Python script failed: ${err.message}\n${stderr}`));
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          return reject(new Error(result.error));
        }
        resolve(result);
      } catch (e) {
        reject(new Error(`Could not parse Python output: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

// ------------------------------------------------------------
// Step 2: Match against local database
// ------------------------------------------------------------

async function findSongInDB(title, artist) {
  const songs = await prisma.song.findMany({
    where: {
      title: { equals: title, mode: 'insensitive' },
    },
    select: {
      id: true,
      title: true,
      artist: true,
      starts: true,
    },
  });

  if (songs.length === 0) return null;

  // If artist provided, try to find a match
  if (artist) {
    const qqArtists = artist.split('_').map((a) => a.trim().toLowerCase());

    for (const song of songs) {
      const dbArtists = song.artist.split('_').map((a) => a.trim().toLowerCase());
      // Match if any QQ artist appears in the DB artist list
      const hasMatch = qqArtists.some((qa) =>
        dbArtists.some((da) => da.includes(qa) || qa.includes(da))
      );
      if (hasMatch) return song;
    }
  }

  // Fall back to first title match if only one result
  return songs.length === 1 ? songs[0] : null;
}

// ------------------------------------------------------------
// Step 3: Run the test
// ------------------------------------------------------------

async function main() {
  const qqPlaylistId = process.argv[2];
  if (!qqPlaylistId) {
    console.error('Usage: node scripts/test-qq-import.js <qqPlaylistId>');
    process.exit(1);
  }

  // Step 1: Fetch from QQ Music
  let qqSongs;
  try {
    qqSongs = await fetchQQPlaylist(qqPlaylistId);
  } catch (err) {
    console.error('Failed to fetch QQ Music playlist:', err.message);
    process.exit(1);
  }

  console.log(`Found ${qqSongs.length} songs in QQ Music playlist\n`);

  if (qqSongs.length === 0) {
    console.log('No songs found.');
    process.exit(0);
  }

  // Step 2: Match against local database
  console.log('=== Matching against local database ===\n');

  const matched = [];
  const notFound = [];

  for (const qqSong of qqSongs) {
    const dbSong = await findSongInDB(qqSong.title, qqSong.artist);

    if (dbSong) {
      const firstStart = dbSong.starts
        ? parseInt(dbSong.starts.split('|')[0], 10)
        : 0;
      matched.push({
        qqTitle: qqSong.title,
        qqArtist: qqSong.artist,
        dbTitle: dbSong.title,
        dbArtist: dbSong.artist,
        dbSongId: dbSong.id,
        firstStart,
      });
      console.log(`  ✓ "${qqSong.title}" - ${qqSong.artist}  →  "${dbSong.title}" - ${dbSong.artist} (start: ${firstStart}s)`);
    } else {
      notFound.push({
        title: qqSong.title,
        artist: qqSong.artist,
      });
      console.log(`  ✗ "${qqSong.title}" - ${qqSong.artist}  →  NOT FOUND`);
    }
  }

  // Step 3: Report
  console.log('\n=== Summary ===');
  console.log(`Total in QQ playlist: ${qqSongs.length}`);
  console.log(`Matched in DB:        ${matched.length}`);
  console.log(`Not found:            ${notFound.length}`);

  if (notFound.length > 0) {
    console.log('\n=== Not Found Songs ===');
    notFound.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.title} - ${s.artist}`);
    });
  }

  if (matched.length > 0) {
    console.log('\n=== Matched Songs ===');
    matched.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.qqTitle} → ${s.dbTitle} - ${s.dbArtist} (start: ${s.firstStart}s)`);
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
