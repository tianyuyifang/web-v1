const prisma = require('../src/db/client');

(async () => {
  const results = await prisma.$queryRaw`
    SELECT u.username, s.title, s.artist
    FROM playlist_clips pc
    JOIN playlists p ON pc.playlist_id = p.id
    JOIN users u ON p.user_id = u.id
    JOIN clips c ON pc.clip_id = c.id
    JOIN songs s ON c.song_id = s.id
    WHERE pc.color_tag LIKE '%#8B6CC1%'
    ORDER BY u.username, s.title
  `;
  results.forEach(r => console.log(`${r.username} | ${r.title} | ${r.artist}`));
  console.log('Total:', results.length);
  await prisma.$disconnect();
})();
