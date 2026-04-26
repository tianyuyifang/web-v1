/**
 * import-playlist-by-kugou.js
 *
 * Scrapes a KuGou Music playlist by specialID, matches songs against the local DB,
 * creates clips if needed, and adds them to the target playlist.
 *
 * Usage: node scripts/import-playlist-by-kugou.js <kugouPlaylistId> <targetPlaylistId>
 *
 * Exports importByKugou() for use by API routes.
 */

require('dotenv').config();
const { execFile } = require('child_process');
const path = require('path');
const prisma = require('../src/db/client');
const { sliceLRC } = require('../src/utils/lrc');
const { clipAudio } = require('./clip-audio');

const CLIP_LENGTH = 20;

function buildClipFilename(title, artist, start) {
  const artists = artist.split('_').map((a) => a.trim()).join(' & ');
  const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '_');
  return `${safe(title)} - ${safe(artists)} - ${start}.mp3`;
}

/**
 * Call kugou-playlist.py to scrape a KuGou playlist.
 *
 * @param {string} kugouPlaylistId — specialID like "collection_3_{uid}_{listid}_0"
 * @returns {Promise<{ title: string, artist: string }[]>}
 */
function fetchKugouPlaylist(kugouPlaylistId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'tests', 'kugou-playlist.py');

    execFile('python', ['-u', scriptPath, kugouPlaylistId], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`KuGou scraper failed: ${err.message}`));
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) return reject(new Error(result.error));
        resolve(result);
      } catch (e) {
        reject(new Error('Could not parse KuGou scraper output'));
      }
    });
  });
}

async function findSongInDB(title, artist) {
  const songs = await prisma.song.findMany({
    where: { title: { equals: title } },
  });
  if (songs.length === 0) return { song: null, artistMatch: false };

  if (artist) {
    const extArtists = artist.split('_').map((a) => a.trim().toLowerCase());
    for (const song of songs) {
      const dbArtists = song.artist.split('_').map((a) => a.trim().toLowerCase());
      const hasMatch = extArtists.some((ea) =>
        dbArtists.some((da) => da.includes(ea) || ea.includes(da))
      );
      if (hasMatch) return { song, artistMatch: true };
    }
  }

  return songs.length === 1 ? { song: songs[0], artistMatch: false } : { song: null, artistMatch: false };
}

async function importByKugou(kugouPlaylistId, targetPlaylistId) {
  const kugouSongs = await fetchKugouPlaylist(kugouPlaylistId);

  if (kugouSongs.length === 0) {
    return { added: 0, skipped: 0, notFound: [], titleConflict: [] };
  }

  const mp3BasePath = process.env.MP3_BASE_PATH;
  const clipsBasePath = process.env.CLIPS_BASE_PATH;

  const existingSongs = await prisma.playlistClip.findMany({
    where: { playlistId: targetPlaylistId },
    include: { clip: { include: { song: { select: { title: true, artist: true } } } } },
  });
  const existingTitleMap = new Map();
  for (const pc of existingSongs) {
    existingTitleMap.set(pc.clip.song.title, pc.clip.song.artist);
  }

  const maxPos = await prisma.playlistClip.aggregate({
    where: { playlistId: targetPlaylistId },
    _max: { position: true },
  });
  let position = (maxPos._max.position ?? -1) + 1;

  let added = 0;
  let skipped = 0;
  const notFound = [];
  const titleConflict = [];

  for (const extSong of kugouSongs) {
    const { song } = await findSongInDB(extSong.title, extSong.artist);

    if (!song) {
      notFound.push(`${extSong.title} - ${extSong.artist}`);
      continue;
    }

    const existingArtist = existingTitleMap.get(song.title);
    if (existingArtist !== undefined) {
      const dbArtists = existingArtist.split('_').map((a) => a.trim().toLowerCase());
      const songArtists = song.artist.split('_').map((a) => a.trim().toLowerCase());
      const sameArtist = songArtists.some((sa) => dbArtists.some((da) => da.includes(sa) || sa.includes(da)));
      if (sameArtist) {
        skipped++;
      } else {
        titleConflict.push({ title: song.title, externalArtist: extSong.artist, localArtist: existingArtist });
      }
      continue;
    }

    const firstStart = song.starts ? parseInt(song.starts.split('|')[0], 10) : 0;

    let clip = await prisma.clip.findFirst({
      where: { songId: song.id, start: firstStart, isGlobal: true },
    }) || await prisma.clip.findFirst({
      where: { songId: song.id, start: firstStart },
    });

    if (!clip) {
      const clipLyrics = sliceLRC(song.lyrics, firstStart, firstStart + CLIP_LENGTH);
      const clipFilename = buildClipFilename(song.title, song.artist, firstStart);
      const sourcePath = path.join(mp3BasePath, song.filePath);
      const outputPath = path.join(clipsBasePath, clipFilename);

      try {
        clipAudio({ sourcePath, outputPath, start: firstStart, length: CLIP_LENGTH, lyrics: clipLyrics });
      } catch (err) {
        console.warn(`  Warning: Could not clip "${song.title}": ${err.message}`);
      }

      clip = await prisma.clip.create({
        data: {
          songId: song.id,
          start: firstStart,
          length: CLIP_LENGTH,
          filePath: clipFilename,
          lyrics: clipLyrics,
        },
      });
    }

    await prisma.playlistClip.create({
      data: { playlistId: targetPlaylistId, clipId: clip.id, position },
    });
    existingTitleMap.set(song.title, song.artist);
    position++;
    added++;
  }

  return { added, skipped, notFound, titleConflict };
}

if (require.main === module) {
  const [kugouId, targetId] = process.argv.slice(2);
  if (!kugouId || !targetId) {
    console.error('Usage: node scripts/import-playlist-by-kugou.js <kugouPlaylistId> <targetPlaylistId>');
    process.exit(1);
  }

  importByKugou(kugouId, targetId)
    .then(({ added, skipped, notFound }) => {
      console.log(`Done. Added: ${added}, Skipped: ${skipped}`);
      if (notFound.length > 0) {
        console.log(`Not found (${notFound.length}):`);
        notFound.forEach((s) => console.log(`  ${s}`));
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { importByKugou, fetchKugouPlaylist };
