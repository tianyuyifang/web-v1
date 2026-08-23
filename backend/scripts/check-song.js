const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

(async () => {
  const filename = '雪花落下 - 周深.mp3';
  const musicDir = '/var/www/music/allSongs';

  // Check file on disk
  const fullPath = path.join(musicDir, filename);
  console.log('File exists:', fs.existsSync(fullPath));
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    console.log('File size:', (stat.size / 1024 / 1024).toFixed(1), 'MB');
    console.log('Modified:', stat.mtime);
  }

  // Search DB by filePath
  const byPath = await prisma.song.findMany({ where: { filePath: filename } });
  console.log('\nDB by filePath:', JSON.stringify(byPath, null, 2));

  // Search DB by title
  const byTitle = await prisma.song.findMany({ where: { title: { contains: '雪花落下' } } });
  console.log('\nDB by title:', JSON.stringify(byTitle, null, 2));

  // Check clips if found
  if (byTitle.length > 0) {
    for (const s of byTitle) {
      const clips = await prisma.clip.findMany({ where: { songId: s.id } });
      console.log(`\nClips for "${s.title}" (${clips.length}):`);
      for (const c of clips) {
        const clipPath = path.join('/var/www/music/clips', c.filePath || '');
        const clipExists = c.filePath ? fs.existsSync(clipPath) : false;
        console.log(`  start=${c.start} file=${c.filePath} exists=${clipExists}`);
      }
    }
  }

  process.exit(0);
})();
