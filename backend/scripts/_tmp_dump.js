const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const songs = await prisma.song.findMany({ select: { id: true, title: true, artist: true, filePath: true } });
  for (const s of songs) process.stdout.write(JSON.stringify(s) + '\n');
  process.exit(0);
})();
