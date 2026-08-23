const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

(async () => {
  const song = await prisma.song.findFirst({ where: { title: '雪花落下' } });
  if (!song) { console.log('Song not found'); process.exit(1); }

  console.log('Song ID:', song.id);
  console.log('Song filePath:', song.filePath);
  console.log('Song duration:', song.duration);

  const srcPath = path.join('/var/www/music/allSongs', song.filePath);
  console.log('Source exists:', fs.existsSync(srcPath));
  if (fs.existsSync(srcPath)) {
    const stat = fs.statSync(srcPath);
    console.log('Source size:', (stat.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('Source modified:', stat.mtime);
  }

  const clips = await prisma.clip.findMany({ where: { songId: song.id } });
  console.log('\nClips:', clips.length);
  for (const c of clips) {
    const clipPath = path.join('/var/www/music/allClips', c.filePath || '');
    const exists = c.filePath ? fs.existsSync(clipPath) : false;
    let size = 0;
    let mtime = null;
    if (exists) {
      const st = fs.statSync(clipPath);
      size = st.size;
      mtime = st.mtime;
    }
    console.log(`  id=${c.id} start=${c.start} version=${c.version} file=${c.filePath} exists=${exists} size=${size} modified=${mtime}`);
  }

  process.exit(0);
})();
