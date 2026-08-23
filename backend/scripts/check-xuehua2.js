const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const song = await prisma.song.findFirst({ where: { filePath: '雪花落下 - 周深.mp3' } });
  if (!song) { console.log('Song not found by filePath'); process.exit(1); }
  console.log('Song ID:', song.id);

  const clips = await prisma.clip.findMany({ where: { songId: song.id } });
  console.log('Clips:', clips.length);
  clips.forEach(c => console.log(`  id=${c.id} start=${c.start} version=${c.version}`));

  // Check if any are in playlists
  for (const c of clips) {
    const pcs = await prisma.playlistClip.findMany({
      where: { clipId: c.id },
      include: { playlist: { select: { name: true } } }
    });
    if (pcs.length) {
      console.log(`  Clip ${c.id} (start=${c.start}) in playlists:`, pcs.map(pc => pc.playlist.name).join(', '));
    } else {
      console.log(`  Clip ${c.id} (start=${c.start}) NOT in any playlist`);
    }
  }

  process.exit(0);
})();
