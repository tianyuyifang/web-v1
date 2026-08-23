const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const song = await prisma.song.findFirst({ where: { title: '雪花落下' } });
  if (!song) { console.log('Song not found in DB'); process.exit(1); }

  const musicDir = '/var/www/music/allSongs';
  const dbPath = path.join(musicDir, song.filePath);

  console.log('DB filePath:', song.filePath);
  console.log('DB filePath hex:', Buffer.from(song.filePath).toString('hex'));
  console.log('Full path:', dbPath);
  console.log('File exists (DB path):', fs.existsSync(dbPath));

  // List files matching partial name
  const files = fs.readdirSync(musicDir).filter(f => f.includes('周深') || f.includes('雪花'));
  console.log('\nMatching files on disk:');
  files.forEach(f => {
    console.log(' ', f);
    console.log('  hex:', Buffer.from(f).toString('hex'));
  });

  process.exit(0);
})();
