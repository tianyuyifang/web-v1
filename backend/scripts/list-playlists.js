const prisma = require('../src/db/client');
const username = process.argv[2];
if (!username) { console.log('Usage: node scripts/list-playlists.js <username>'); process.exit(1); }
(async () => {
  const user = await prisma.user.findFirst({ where: { username } });
  if (!user) { console.log('User not found: ' + username); process.exit(0); }
  const playlists = await prisma.playlist.findMany({
    where: { userId: user.id },
    include: { _count: { select: { playlistClips: true } } },
    orderBy: { name: 'asc' },
  });
  playlists.forEach((p, i) => {
    console.log((i+1) + '. ' + p.name + ' (' + p._count.playlistClips + ' clips) ' + (p.isPublic ? '[public]' : '[private]'));
  });
  console.log('Total: ' + playlists.length + ' playlists');
  await prisma.$disconnect();
})();
