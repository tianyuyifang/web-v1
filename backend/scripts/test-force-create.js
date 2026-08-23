const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { clipAudio } = require('./clip-audio');

const prisma = new PrismaClient();

(async () => {
  const song = await prisma.song.findFirst({ where: { filePath: '雪花落下 - 周深.mp3' } });
  if (!song) { console.log('Song not found'); process.exit(1); }

  const start = 62;
  const length = 20;
  const clipFilename = '雪花落下 - 周深 - 62.mp3';
  const sourcePath = path.join(config.mp3BasePath, song.filePath);
  const outputPath = path.join(config.clipsBasePath, clipFilename);

  console.log('Source:', sourcePath);
  console.log('Source exists:', fs.existsSync(sourcePath));
  console.log('Source size:', fs.statSync(sourcePath).size, 'bytes');

  // Check old clip
  if (fs.existsSync(outputPath)) {
    const oldStat = fs.statSync(outputPath);
    console.log('\nOld clip size:', oldStat.size, 'bytes');
    console.log('Old clip modified:', oldStat.mtime);

    // Read first 100 bytes for comparison
    const oldHead = Buffer.alloc(100);
    const fd = fs.openSync(outputPath, 'r');
    fs.readSync(fd, oldHead, 0, 100, 0);
    fs.closeSync(fd);
    console.log('Old clip header:', oldHead.toString('hex').substring(0, 40));

    // Delete it
    fs.unlinkSync(outputPath);
    console.log('Deleted old clip');
  }

  // Regenerate
  console.log('\nClipping...');
  try {
    clipAudio({ sourcePath, outputPath, start, length, lyrics: null });
    console.log('Clip created successfully');
  } catch (e) {
    console.log('Clip ERROR:', e.message);
    process.exit(1);
  }

  if (fs.existsSync(outputPath)) {
    const newStat = fs.statSync(outputPath);
    console.log('New clip size:', newStat.size, 'bytes');
    console.log('New clip modified:', newStat.mtime);

    const newHead = Buffer.alloc(100);
    const fd = fs.openSync(outputPath, 'r');
    fs.readSync(fd, newHead, 0, 100, 0);
    fs.closeSync(fd);
    console.log('New clip header:', newHead.toString('hex').substring(0, 40));
  } else {
    console.log('ERROR: New clip file not created!');
  }

  process.exit(0);
})();
