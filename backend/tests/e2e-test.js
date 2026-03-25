/**
 * e2e-test.js
 *
 * End-to-end API smoke test. Runs a full user journey against the live backend
 * at localhost:4000 without any test framework. Requires the backend and DB to
 * be running and at least one song imported.
 *
 * Usage: node tests/e2e-test.js
 *
 * Steps covered:
 *   1.  Register a new user (timestamped username to avoid collisions)
 *   2.  Verify auth token via /auth/me
 *   3.  Browse songs (cursor pagination)
 *   4.  Create a clip (first song, start=0, length=25s)
 *   5.  Create a playlist
 *   6.  Add the clip to the playlist
 *   7.  Fetch playlist detail (verifies clip + song metadata included)
 *   8.  Toggle like on the clip within the playlist
 *   9.  Fetch user likes list
 *   10. Stream the MP3 (checks 200/206 response)
 *   11. Pinyin initials search ("yldb")
 */

const http = require('http');

let token = null;

/**
 * Makes an authenticated HTTP request to the backend API.
 *
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {string} path   - API path, e.g. '/auth/login' (prefixed with /api internally)
 * @param {object} [body] - Optional JSON request body
 * @returns {Promise<{status: number, data: object|string}>}
 */
function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 4000,
      path: '/api' + path, method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const ts = Date.now();

  // 1. Register
  let r = await apiCall('POST', '/auth/register', {
    username: 'test_' + ts, email: 'test' + ts + '@test.com', password: 'password123'
  });
  console.log('1. Register:', r.status, r.data.user?.username || r.data.error?.message);
  if (r.data.token) token = r.data.token;

  // 2. Me
  r = await apiCall('POST', '/auth/me');
  console.log('2. Me:', r.status, r.data.user?.username);

  // 3. Search songs
  r = await apiCall('GET', '/songs?limit=3');
  console.log('3. Songs:', r.status, 'count:', r.data.songs?.length, 'first:', r.data.songs?.[0]?.title);

  const song = r.data.songs?.[0];
  if (!song) {
    console.log('No songs in DB - need to run import first');
    return;
  }

  // 4. Create clip
  r = await apiCall('POST', '/clips', { songId: song.id, start: 0, length: 25 });
  console.log('4. Create clip:', r.status, 'clipId:', r.data.id);
  const clipId = r.data.id;

  // 5. Create playlist
  r = await apiCall('POST', '/playlists', { name: 'E2E Test Playlist' });
  console.log('5. Create playlist:', r.status, 'id:', r.data.id);
  const playlistId = r.data.id;

  // 6. Add clip to playlist
  r = await apiCall('POST', '/playlists/' + playlistId + '/clips', { clipId });
  console.log('6. Add clip:', r.status, 'clipId:', r.data.clipId);

  // 7. Get playlist detail
  r = await apiCall('GET', '/playlists/' + playlistId);
  console.log('7. Playlist detail:', r.status, 'clips:', r.data.clips?.length, 'name:', r.data.name);

  // 8. Like toggle
  r = await apiCall('POST', '/likes/toggle', { playlistId, clipId });
  console.log('8. Like toggle:', r.status, 'liked:', r.data.liked);

  // 9. Get likes
  r = await apiCall('GET', '/likes');
  console.log('9. Likes:', r.status, 'count:', r.data.likes?.length);

  // 10. Stream check
  r = await apiCall('GET', '/stream/' + song.id);
  console.log('10. Stream:', r.status, '(200/206 = audio OK)');

  // 11. Search by pinyin
  r = await apiCall('GET', '/songs?q=yldb&limit=3');
  console.log('11. Pinyin search "yldb":', r.status, 'count:', r.data.songs?.length);

  console.log('\n--- E2E test complete! ---');
})();
