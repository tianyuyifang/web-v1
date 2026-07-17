/**
 * import-playlist-by-file.js
 *
 * Reads an xlsx file with columns (title, artist), matches songs in the DB,
 * creates clips at each song's default start time if they don't exist,
 * and adds them to the target playlist.
 *
 * Usage: node scripts/import-playlist-by-file.js <xlsxFilePath> <targetPlaylistId>
 *
 * XLSX format:
 *   Column A: title (song title, e.g. "小情歌")
 *   Column B: artist (artist name, e.g. "苏打绿")
 *
 * Exports importByFile() for use by API routes.
 */

require('dotenv').config();
const XLSX = require('xlsx');
const { addSongsToPlaylist } = require('./lib/add-songs');

/**
 * Parse an xlsx buffer or file path into an array of { title, artist }.
 *
 * @param {Buffer|string} input - xlsx file buffer or file path
 * @returns {{ title: string, artist: string }[]}
 */
function parseXlsx(input) {
  const workbook = Buffer.isBuffer(input)
    ? XLSX.read(input, { type: 'buffer' })
    : XLSX.readFile(input);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows
    .map((row) => ({
      title: (row.title || row.Title || row['标题'] || '').toString().trim(),
      artist: (row.artist || row.Artist || row['歌手'] || '').toString().trim(),
    }))
    .filter((r) => r.title);
}

/**
 * Import clips from an xlsx file into a playlist.
 *
 * @param {Buffer|string} input - xlsx buffer or file path
 * @param {string} targetPlaylistId - playlist to add clips to
 * @returns {{ added: number, skipped: number, notFound: string[] }}
 */
async function importByFile(input, targetPlaylistId, onProgress) {
  const entries = parseXlsx(input);
  return addSongsToPlaylist(entries, targetPlaylistId, onProgress);
}

// CLI usage
if (require.main === module) {
  const [filePath, targetId] = process.argv.slice(2);
  if (!filePath || !targetId) {
    console.error('Usage: node scripts/import-playlist-by-file.js <xlsxFile> <targetPlaylistId>');
    process.exit(1);
  }

  importByFile(filePath, targetId)
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

module.exports = { importByFile };
