const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const prisma = new PrismaClient();

(async () => {
  const song = await prisma.song.findFirst({ where: { filePath: '雪花落下 - 周深.mp3' } });
  if (!song) { console.log('Song not found'); process.exit(1); }

  const clip = await prisma.clip.findFirst({ where: { songId: song.id, start: 62 } });
  if (!clip) { console.log('Clip at start=62 not found'); process.exit(1); }

  console.log('Clip ID:', clip.id);
  console.log('File:', clip.filePath);

  // Remove from playlists
  const pcs = await prisma.playlistClip.findMany({
    where: { clipId: clip.id },
    include: { playlist: { select: { name: true } } }
  });
  console.log('In playlists:', pcs.map(pc => pc.playlist.name).join(', '));

  // Delete playlist_clips
  const pcDel = await prisma.playlistClip.deleteMany({ where: { clipId: clip.id } });
  console.log('Deleted', pcDel.count, 'playlist_clips');

  // Delete likes
  const likesDel = await prisma.like.deleteMany({ where: { clipId: clip.id } });
  console.log('Deleted', likesDel.count, 'likes');

  // Delete clip record
  await prisma.clip.delete({ where: { id: clip.id } });
  console.log('Deleted clip from DB');

  // Delete clip file on disk
  if (clip.filePath) {
    const clipPath = path.join(config.clipsBasePath, clip.filePath);
    try { fs.unlinkSync(clipPath); console.log('Deleted clip file:', clipPath); } catch { console.log('Clip file not found on disk'); }
    const lrcPath = clipPath.replace(/\.mp3$/i, '.lrc');
    try { fs.unlinkSync(lrcPath); console.log('Deleted LRC file'); } catch {}
  }

  // Update song.starts
  const starts = (song.starts || '').split('|').filter(s => s !== '62').join('|');
  await prisma.song.update({ where: { id: song.id }, data: { starts } });
  console.log('Updated song.starts:', starts);

  console.log('Done');
  process.exit(0);
})();
