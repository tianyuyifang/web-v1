/**
 * db-summary.js
 *
 * Prints a human-readable summary of every table in the database. Useful for
 * verifying imports, inspecting test data, and debugging state after E2E runs.
 * Read-only — makes no writes to the database.
 *
 * Usage: node tests/db-summary.js
 *
 * Tables printed:
 *   Users, Songs, SongArtists, Clips, Playlists, PlaylistClips,
 *   Likes, PlaylistShares, CopyPermissions
 */

const prisma = require('../src/db/client');

/**
 * Queries all tables and prints formatted summaries to stdout, then exits.
 * Calls process.exit(0) on success or process.exit(1) on error.
 *
 * @returns {Promise<void>}
 */
async function main() {
  // Users
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(`\n=== Users (${users.length}) ===`);
  console.log('  id | username | role | preferences | createdAt | updatedAt');
  users.forEach(u => console.log(
    `  ${u.id} | ${u.username} | ${u.role} | ${JSON.stringify(u.preferences ?? {})} | ${u.createdAt.toISOString()} | ${u.updatedAt.toISOString()}`
  ));

  // Songs
  const songs = await prisma.song.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  console.log(`\n=== Songs (${songs.length}) ===`);
  console.log('  id | title | artist | duration | filePath | starts | titlePinyin | titlePinyinInitials | artistPinyin | artistPinyinInitials | createdAt | updatedAt');
  songs.forEach(s => console.log(
    `  ${s.id} | ${s.title} | ${s.artist} | ${s.duration ?? 'null'} | ${s.filePath} | ${s.starts ?? 'null'} | ${s.titlePinyin ?? 'null'} | ${s.titlePinyinInitials ?? 'null'} | ${s.artistPinyin ?? 'null'} | ${s.artistPinyinInitials ?? 'null'} | ${s.createdAt.toISOString()} | ${s.updatedAt.toISOString()}`
  ));

  // SongArtists
  const songArtists = await prisma.songArtist.findMany({
    orderBy: { position: 'asc' },
    take: 5,
  });
  console.log(`\n=== SongArtists (${songArtists.length}) ===`);
  console.log('  id | songId | artistName | artistPinyin | artistPinyinInitials | position');
  songArtists.forEach(a => console.log(
    `  ${a.id} | ${a.songId} | ${a.artistName} | ${a.artistPinyin ?? 'null'} | ${a.artistPinyinInitials ?? 'null'} | ${a.position}`
  ));

  // Clips
  const clips = await prisma.clip.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(`\n=== Clips (${clips.length}) ===`);
  console.log('  id | songId | start | length | lyrics | createdAt');
  clips.forEach(c => console.log(
    `  ${c.id} | ${c.songId} | ${c.start} | ${c.length} | ${c.lyrics ? c.lyrics.slice(0, 40).replace(/\n/g, ' ') + '...' : 'null'} | ${c.createdAt.toISOString()}`
  ));

  // Playlists
  const playlists = await prisma.playlist.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(`\n=== Playlists (${playlists.length}) ===`);
  console.log('  id | userId | name | description | isPublic | namePinyin | namePinyinInitials | createdAt | updatedAt');
  playlists.forEach(p => console.log(
    `  ${p.id} | ${p.userId} | ${p.name} | ${p.description ?? 'null'} | ${p.isPublic} | ${p.namePinyin ?? 'null'} | ${p.namePinyinInitials ?? 'null'} | ${p.createdAt.toISOString()} | ${p.updatedAt.toISOString()}`
  ));

  // PlaylistClips
  const playlistClips = await prisma.playlistClip.findMany({
    orderBy: [{ playlistId: 'asc' }, { position: 'asc' }],
    take: 5,
  });
  console.log(`\n=== PlaylistClips (${playlistClips.length}) ===`);
  console.log('  id | playlistId | clipId | position | speed | pitch | colorTag | comment | addedAt');
  playlistClips.forEach(pc => console.log(
    `  ${pc.id} | ${pc.playlistId} | ${pc.clipId} | ${pc.position} | ${pc.speed} | ${pc.pitch} | ${pc.colorTag ?? 'null'} | ${pc.comment ?? 'null'} | ${pc.addedAt.toISOString()}`
  ));

  // Likes
  const likes = await prisma.like.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(`\n=== Likes (${likes.length}) ===`);
  console.log('  id | userId | playlistId | clipId | createdAt');
  likes.forEach(l => console.log(
    `  ${l.id} | ${l.userId} | ${l.playlistId} | ${l.clipId} | ${l.createdAt.toISOString()}`
  ));

  // PlaylistShares
  const shares = await prisma.playlistShare.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(`\n=== PlaylistShares (${shares.length}) ===`);
  console.log('  id | playlistId | userId | createdAt');
  shares.forEach(s => console.log(
    `  ${s.id} | ${s.playlistId} | ${s.userId} | ${s.createdAt.toISOString()}`
  ));

  // CopyPermissions
  const copyPerms = await prisma.playlistCopyPermission.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(`\n=== CopyPermissions (${copyPerms.length}) ===`);
  console.log('  id | playlistId | userId | createdAt');
  copyPerms.forEach(c => console.log(
    `  ${c.id} | ${c.playlistId} | ${c.userId} | ${c.createdAt.toISOString()}`
  ));
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
