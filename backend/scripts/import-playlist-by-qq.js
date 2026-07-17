/**
 * import-playlist-by-qq.js
 *
 * Scrapes a QQ Music playlist by ID, matches songs against the local DB,
 * creates clips if needed, and adds them to the target playlist.
 *
 * Usage: node scripts/import-playlist-by-qq.js <qqPlaylistId> <targetPlaylistId>
 *
 * Exports importByQQ() for use by API routes.
 */

require('dotenv').config();
const { execFile } = require('child_process');
const path = require('path');
const { addSongsToPlaylist } = require('./lib/add-songs');

/**
 * Call qq-playlist.py to scrape a QQ Music playlist.
 *
 * @param {string} qqPlaylistId
 * @returns {Promise<{ title: string, artist: string }[]>}
 */
function fetchQQPlaylist(qqPlaylistId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'tests', 'qq-playlist.py');

    execFile('python', ['-u', scriptPath, qqPlaylistId], {
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`QQ Music scraper failed: ${err.message}`));
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          return reject(new Error(result.error));
        }
        resolve(result);
      } catch (e) {
        reject(new Error('Could not parse QQ Music scraper output'));
      }
    });
  });
}

/**
 * Import songs from a QQ Music playlist into a local playlist.
 *
 * @param {string} qqPlaylistId - QQ Music playlist ID
 * @param {string} targetPlaylistId - Local playlist ID to add clips to
 * @returns {{ added: number, skipped: number, notFound: string[] }}
 */
async function importByQQ(qqPlaylistId, targetPlaylistId, onProgress) {
  const qqSongs = await fetchQQPlaylist(qqPlaylistId);
  return addSongsToPlaylist(qqSongs, targetPlaylistId, onProgress);
}

// CLI usage
if (require.main === module) {
  const [qqId, targetId] = process.argv.slice(2);
  if (!qqId || !targetId) {
    console.error('Usage: node scripts/import-playlist-by-qq.js <qqPlaylistId> <targetPlaylistId>');
    process.exit(1);
  }

  importByQQ(qqId, targetId)
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

module.exports = { importByQQ, fetchQQPlaylist };
