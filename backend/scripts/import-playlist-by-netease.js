/**
 * import-playlist-by-netease.js
 *
 * Fetches a NetEase Cloud Music playlist by ID, matches songs against the local DB,
 * creates clips if needed, and adds them to the target playlist.
 *
 * Usage: node scripts/import-playlist-by-netease.js <neteasePlaylistId> <targetPlaylistId>
 *
 * Exports importByNetease() for use by API routes.
 */

require('dotenv').config();
const { addSongsToPlaylist } = require('./lib/add-songs');

/**
 * Fetch playlist tracks from NetEase Cloud Music API.
 *
 * @param {string} neteasePlaylistId
 * @returns {Promise<{ title: string, artist: string }[]>}
 */
async function fetchNeteasePlaylist(neteasePlaylistId) {
  const url = 'https://music.163.com/api/v6/playlist/detail';
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://music.163.com/',
  };

  const resp = await fetch(`${url}?id=${encodeURIComponent(neteasePlaylistId)}`, { headers });
  if (!resp.ok) {
    throw new Error(`NetEase API HTTP ${resp.status}`);
  }

  const data = await resp.json();
  if (data.code !== 200) {
    throw new Error(`NetEase API error: ${data.code} - ${data.msg || 'unknown error'}`);
  }

  let tracks = data.playlist?.tracks || [];
  const trackIds = (data.playlist?.trackIds || []).map((t) => t.id);

  // API only returns a subset of full tracks; fetch all via trackIds
  if (trackIds.length > tracks.length) {
    tracks = await fetchTrackDetails(trackIds, headers);
  }

  return tracks.map((track) => ({
    title: track.name,
    artist: (track.ar || []).map((a) => a.name).join('_'),
  }));
}

/**
 * Fetch full track details when playlist only returns IDs.
 */
async function fetchTrackDetails(trackIds, headers) {
  const url = 'https://music.163.com/api/v3/song/detail';
  const allTracks = [];
  const batchSize = 500;

  for (let i = 0; i < trackIds.length; i += batchSize) {
    const batch = trackIds.slice(i, i + batchSize);
    const c = JSON.stringify(batch.map((id) => ({ id })));

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `c=${encodeURIComponent(c)}`,
    });

    if (!resp.ok) {
      throw new Error(`NetEase song detail API HTTP ${resp.status}`);
    }

    const data = await resp.json();
    allTracks.push(...(data.songs || []));
  }

  return allTracks;
}

/**
 * Find a song in the local DB by title and artist.
 * Returns { song, artistMatch } so callers can track mismatches.
 */
/**
 * Import songs from a NetEase Cloud Music playlist into a local playlist.
 *
 * @param {string} neteasePlaylistId - NetEase playlist ID
 * @param {string} targetPlaylistId - Local playlist ID to add clips to
 * @returns {{ added: number, skipped: number, notFound: string[] }}
 */
async function importByNetease(neteasePlaylistId, targetPlaylistId, onProgress) {
  const neteaseSongs = await fetchNeteasePlaylist(neteasePlaylistId);
  return addSongsToPlaylist(neteaseSongs, targetPlaylistId, onProgress);
}

// CLI usage
if (require.main === module) {
  const [neteaseId, targetId] = process.argv.slice(2);
  if (!neteaseId || !targetId) {
    console.error('Usage: node scripts/import-playlist-by-netease.js <neteasePlaylistId> <targetPlaylistId>');
    process.exit(1);
  }

  importByNetease(neteaseId, targetId)
    .then(({ added, skipped, notFound }) => {
      console.log(`Done. Added: ${added}, Skipped: ${skipped}`);
      if (notFound.length > 0) {
        console.log(`Not found (${notFound.length}):`);
        notFound.forEach((s) => console.log(`  ${s}`));
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { importByNetease, fetchNeteasePlaylist };
