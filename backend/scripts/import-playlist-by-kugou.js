/**
 * import-playlist-by-kugou.js
 *
 * Scrapes a KuGou Music playlist by specialID, matches songs against the local DB,
 * creates clips if needed, and adds them to the target playlist.
 *
 * Usage: node scripts/import-playlist-by-kugou.js <kugouPlaylistId> <targetPlaylistId>
 *
 * Exports importByKugou() for use by API routes.
 */

require('dotenv').config();
const { execFile } = require('child_process');
const path = require('path');
const { addSongsToPlaylist } = require('./lib/add-songs');

/**
 * Call kugou-playlist.py to scrape a KuGou playlist.
 *
 * @param {string} kugouPlaylistId — specialID like "collection_3_{uid}_{listid}_0"
 * @returns {Promise<{ title: string, artist: string }[]>}
 */
function fetchKugouPlaylist(kugouPlaylistId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'tests', 'kugou-playlist.py');

    execFile('python', ['-u', scriptPath, kugouPlaylistId], {
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`KuGou scraper failed: ${err.message}`));
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) return reject(new Error(result.error));
        resolve(result);
      } catch (e) {
        reject(new Error('Could not parse KuGou scraper output'));
      }
    });
  });
}

async function importByKugou(kugouPlaylistId, targetPlaylistId, onProgress) {
  const kugouSongs = await fetchKugouPlaylist(kugouPlaylistId);
  return addSongsToPlaylist(kugouSongs, targetPlaylistId, onProgress);
}

if (require.main === module) {
  const [kugouId, targetId] = process.argv.slice(2);
  if (!kugouId || !targetId) {
    console.error('Usage: node scripts/import-playlist-by-kugou.js <kugouPlaylistId> <targetPlaylistId>');
    process.exit(1);
  }

  importByKugou(kugouId, targetId)
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

module.exports = { importByKugou, fetchKugouPlaylist };
