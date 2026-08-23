const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.$queryRaw`
    SELECT s.title, s.artist, p.name AS playlist_name, pc.comment, u.username AS owner,
      (SELECT string_agg(DISTINCT p2.name, ', ' ORDER BY p2.name)
       FROM playlist_clips pc2
       JOIN clips c2 ON c2.id = pc2.clip_id
       JOIN playlists p2 ON p2.id = pc2.playlist_id
       WHERE c2.song_id = s.id
      ) AS all_playlists
    FROM playlist_clips pc
    JOIN clips c ON c.id = pc.clip_id
    JOIN songs s ON s.id = c.song_id
    JOIN playlists p ON p.id = pc.playlist_id
    JOIN users u ON u.id = p.user_id
    WHERE pc.color_tag LIKE '%#8B6CC1%'
    ORDER BY p.name, s.title
  `;
  rows.forEach(r => console.log(JSON.stringify(r)));
  process.exit(0);
})();
