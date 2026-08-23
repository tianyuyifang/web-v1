const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

// Configure paths based on environment
const isRemote = process.argv.includes('--remote');
const mp3Base = isRemote ? '/var/www/music/allSongs' : 'C:/Projects/web-v1/music/allSongs';
const clipsBase = isRemote ? '/var/www/music/allClips' : 'C:/Projects/web-v1/music/allClips';

const TARGET = '我是真的爱你 - 王杰.mp3';

(async () => {
  const song = await prisma.song.findFirst({ where: { filePath: TARGET } });
  if (!song) { console.log('Song not found in DB'); process.exit(1); }

  console.log('Song:', song.title, '-', song.artist);
  console.log('Song ID:', song.id);

  // Find all clips
  const clips = await prisma.clip.findMany({ where: { songId: song.id } });
  console.log('Clips:', clips.length);

  for (const c of clips) {
    // Remove playlist_clips
    const pcDel = await prisma.playlistClip.deleteMany({ where: { clipId: c.id } });
    if (pcDel.count) console.log(`  Clip ${c.start}s: removed from ${pcDel.count} playlists`);

    // Remove likes
    const likesDel = await prisma.like.deleteMany({ where: { clipId: c.id } });
    if (likesDel.count) console.log(`  Clip ${c.start}s: removed ${likesDel.count} likes`);

    // Delete clip file
    if (c.filePath) {
      const clipPath = path.join(clipsBase, c.filePath);
      try { fs.unlinkSync(clipPath); console.log(`  Deleted clip file: ${c.filePath}`); } catch {}
      try { fs.unlinkSync(clipPath.replace(/\.mp3$/i, '.lrc')); } catch {}
    }
  }

  // Delete all clips from DB
  const clipsDel = await prisma.clip.deleteMany({ where: { songId: song.id } });
  console.log('Deleted', clipsDel.count, 'clips from DB');

  // Delete song_artists
  const artistsDel = await prisma.songArtist.deleteMany({ where: { songId: song.id } });
  console.log('Deleted', artistsDel.count, 'song_artists');

  // Delete song
  await prisma.song.delete({ where: { id: song.id } });
  console.log('Deleted song from DB');

  // Delete MP3 and LRC from storage
  const mp3Path = path.join(mp3Base, TARGET);
  try { fs.unlinkSync(mp3Path); console.log('Deleted MP3:', mp3Path); } catch { console.log('MP3 not found on disk'); }
  const lrcPath = mp3Path.replace(/\.mp3$/i, '.lrc');
  try { fs.unlinkSync(lrcPath); console.log('Deleted LRC'); } catch {}

  console.log('Done');
  process.exit(0);
})();
