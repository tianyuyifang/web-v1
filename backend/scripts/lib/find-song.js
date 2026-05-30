/**
 * Shared song-matching logic for all playlist importers
 * (QQ, NetEase, KuGou, xlsx file).
 *
 * Looks up a song by title, then disambiguates by artist. When several songs
 * share the title and none matches the external artist, instead of giving up
 * it falls back to the most popular candidate — the song used in the most
 * playlists across all users, tie-broken by total likes (then by id for
 * determinism). This keeps imports from silently dropping a song just because
 * the source's artist string didn't line up.
 */

const prisma = require('../../src/db/client');
const { Prisma } = require('@prisma/client');

/**
 * Find a song in the local DB by title and (fuzzy) artist.
 *
 * @param {string} title  - song title from the external source
 * @param {string} artist - artist string, multiple artists joined by '_'
 * @returns {Promise<{ song: object|null, artistMatch: boolean }>}
 */
async function findSongInDB(title, artist) {
  const songs = await prisma.song.findMany({
    where: { title: { equals: title } },
  });

  if (songs.length === 0) return { song: null, artistMatch: false };

  if (artist) {
    const extArtists = artist.split('_').map((a) => a.trim().toLowerCase());
    for (const song of songs) {
      const dbArtists = song.artist.split('_').map((a) => a.trim().toLowerCase());
      const hasMatch = extArtists.some((ea) =>
        dbArtists.some((da) => da.includes(ea) || ea.includes(da))
      );
      if (hasMatch) return { song, artistMatch: true };
    }
  }

  // No artist match. Single candidate → use it. Otherwise pick the most popular.
  if (songs.length === 1) return { song: songs[0], artistMatch: false };

  const song = await pickMostPopular(songs);
  return { song, artistMatch: false };
}

/**
 * Among same-title candidates, pick the one used in the most playlists across
 * all users. Tie-break by total likes, then by id (deterministic).
 *
 * @param {object[]} songs - candidate song rows (all sharing a title)
 * @returns {Promise<object>} the chosen song
 */
async function pickMostPopular(songs) {
  const songIds = songs.map((s) => s.id);

  // Distinct playlists each candidate appears in (via its clips), plus total
  // likes on those clips. Cast bound text params to uuid[] to match song_id.
  const stats = await prisma.$queryRaw`
    SELECT
      c.song_id AS "songId",
      COUNT(DISTINCT pc.playlist_id)::int AS "playlistCount",
      COUNT(DISTINCT l.id)::int           AS "likeCount"
    FROM clips c
    LEFT JOIN playlist_clips pc ON pc.clip_id = c.id
    LEFT JOIN likes l           ON l.clip_id = c.id
    WHERE c.song_id = ANY(ARRAY[${Prisma.join(songIds)}]::uuid[])
    GROUP BY c.song_id
  `;

  const byId = new Map(
    stats.map((r) => [r.songId, { playlists: r.playlistCount, likes: r.likeCount }])
  );
  const stat = (id) => byId.get(id) || { playlists: 0, likes: 0 };

  return [...songs].sort((a, b) => {
    const sa = stat(a.id);
    const sb = stat(b.id);
    if (sb.playlists !== sa.playlists) return sb.playlists - sa.playlists;
    if (sb.likes !== sa.likes) return sb.likes - sa.likes;
    return a.id.localeCompare(b.id);
  })[0];
}

module.exports = { findSongInDB, pickMostPopular };
