/**
 * QQ打标 lists read by the user's browser (用户 IP mode): the server side.
 * Needs a backend on TEST_BASE (default http://localhost:4300), same database.
 * Run: node tests/qq-browser-reads-test.js
 *
 * A throwaway ADMIN with a FAKE QQ credential; nothing here reaches QQ -- a
 * list the browser supplied must be served from the cache, so a GET that
 * would otherwise read QQ (and fail with the fake key) proves the cache hit.
 */
require('dotenv').config();
const assert = require('assert');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db/client');
const creds = require('../src/services/musicCredentialService');
const settings = require('../src/services/settingsService');
const tags = require('../src/services/platformTagService');

const BASE = process.env.TEST_BASE || 'http://localhost:4300';
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; console.log('  ✓', m); };

(async () => {
  const user = await prisma.user.create({ data: { username: `__qqread_${Date.now()}`, passwordHash: 'x', role: 'ADMIN' } });
  const saved = await prisma.setting.findUnique({ where: { key: settings.QQ_DIRECT_KEY } });
  const tok = jwt.sign({ sub: user.id, username: user.username, role: 'ADMIN' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const setMode = async (mode) => {
    await prisma.setting.upsert({ where: { key: settings.QQ_DIRECT_KEY }, create: { key: settings.QQ_DIRECT_KEY, value: { mode, adminsOnly: true, hedgeMs: 500 } }, update: { value: { mode, adminsOnly: true, hedgeMs: 500 } } });
    await new Promise((r) => setTimeout(r, 10500)); // the server's settings cache
  };
  try {
    // --- session: QQ打标 is user-IP only, whatever 唱卡's play-URL mode is
    await setMode('server');
    let r = await call('GET', '/platform-tagging/qq-read-session');
    ok(r.status === 200 && r.body.mode === 'none' && r.body.reason === 'no-credential', 'no QQ connected: nothing handed over, and no server read either');
    await creds.setCredential(user.id, 'qq', 'uin=10001; qm_keyst=W_Xfake', {
      method: 'qr', uin: '10001', refreshKey: 'rk',
      expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(), needRefreshInSec: 0,
    });
    r = await call('GET', '/platform-tagging/qq-read-session');
    ok(r.body.mode === 'browser' && r.body.uin === '10001' && r.body.musicKey === 'W_Xfake', '唱卡 on 网站 IP, QQ打标 still the browser: uin + musicKey handed over');
    ok(r.body.loginType === 1, 'login type for the browser\'s writes (W_X key: 1)');
    ok(!('cookie' in r.body) && !JSON.stringify(r.body).includes('qm_keyst'), 'the cookie is never handed over');

    // --- annotate
    r = await call('POST', '/platform-tagging/playlists/annotate', {
      uin: '10001',
      playlists: [{ ref: 'qq:777', id: '777', dirId: 3, name: '晴天合集', count: 2, cover: null, isLikes: false, kind: 'created' }],
      calls: 3,
    });
    ok(r.status === 200 && r.body.playlists[0].searchText && r.body.playlists[0].searchText.includes('qingtian'), 'annotate adds the pinyin search text');
    r = await call('POST', '/platform-tagging/playlists/annotate', { uin: '10001', playlists: [{ ref: 'netease:1', id: '1' }] });
    ok(r.status === 400, 'a malformed listing is refused');

    // --- supply, then the page's own GET is served from it
    // Rows: [id, songType, mid, title, artist, durationSec, vipOnly].
    const rows = [
      ['1001', 0, 'm1', '晴天', '周杰伦', 269, false],
      ['1002', 1, 'm2', '七里香', '周杰伦', 299, true],
    ];
    r = await call('GET', '/platform-tagging/playlists/qq:777/songs?dirId=3&cachedOnly=1');
    ok(r.status === 204, 'cachedOnly with nothing cached: 204 (and no platform read)');
    r = await call('POST', '/platform-tagging/playlists/qq:777/supply', { uin: '10001', title: '晴天合集', rows, likedIds: ['1002'], dirId: 3, readMs: 800, calls: 2 });
    ok(r.status === 200 && r.body.total === 2, 'supply accepted');
    ok(r.body.songs.find((x) => x.id === '1002').alreadyLiked === true && r.body.songs.find((x) => x.id === '1001').alreadyLiked === false, 'liked state carried');
    ok(typeof r.body.songs[0].searchText === 'string' && r.body.songs[0].searchText.length > 0, 'songs carry search text');
    r = await call('GET', '/platform-tagging/playlists/qq:777/songs?dirId=3');
    ok(r.status === 200 && r.body.total === 2 && r.body.songs[0].title === '晴天', 'GET .../songs served from the supplied list (no QQ read: the key is fake)');
    r = await call('GET', '/platform-tagging/playlists/qq:777/songs?dirId=3&cachedOnly=1');
    ok(r.status === 200 && r.body.total === 2 && r.body.songs[1].alreadyLiked === true, 'cachedOnly once supplied: the list');

    // --- shapes refused
    r = await call('POST', '/platform-tagging/playlists/netease:5/supply', { uin: '10001', title: null, rows: [], likedIds: [] });
    ok(r.status === 400, 'NetEase lists are not supplied this way');
    r = await call('POST', '/platform-tagging/playlists/qq:777/supply', { uin: '10001', title: null, rows: [['abc', 0, null, 'x', 'y', null, false]], likedIds: [] });
    ok(r.status === 400, 'a malformed song is refused');
    r = await call('POST', '/platform-tagging/playlists/qq:777/supply', { uin: '10001', title: null, songs: [{ id: '1', songType: 0 }], likedIds: [] });
    ok(r.status === 400, 'the old object format is refused');
    r = await call('POST', '/platform-tagging/playlists/annotate', { uin: '10001', playlists: [], euin: 'bad euin<>' });
    ok(r.status === 400, 'a malformed euin is refused');

    // --- a full 5000-song list passes the body limit on this route only
    const big = Array.from({ length: 5000 }, (_, i) => [String(1000000 + i), 0, `0039MnYb0qxYh${i % 10}`, `歌曲名字比较长的一首歌 ${i}`, '某位歌手/另一位歌手', 200, false]);
    const bigBody = JSON.stringify({ uin: '10001', title: '大歌单', rows: big, likedIds: big.slice(0, 500).map((x) => x[0]) });
    const kb = Math.round(Buffer.byteLength(bigBody) / 1024);
    r = await call('POST', '/platform-tagging/playlists/qq:778/supply', bigBody);
    ok(r.status === 200 && r.body.total === 5000, `5000 songs (${kb} KB on the wire) accepted on the supply route`);
    ok(kb < 1024, `and under nginx's 1 MB default (${kb} KB)`);
    r = await call('POST', '/platform-tagging/start', JSON.stringify({ pad: 'x'.repeat(200 * 1024) }));
    ok(r.status === 413, 'other routes keep the 100 kB default');

    // --- read as another QQ account than the one connected now
    r = await call('POST', '/platform-tagging/playlists/qq:777/supply', { uin: '20002', title: null, rows, likedIds: [] });
    ok(r.status === 409 && r.body.error.code === 'ACCOUNT_CHANGED', 'supply from another account: refused');
    r = await call('POST', '/platform-tagging/playlists/annotate', { uin: '20002', playlists: [], euin: 'ABCDefgh1234' });
    ok(r.status === 409, 'annotate from another account: refused');
    const after = await creds.getCredential(user.id, 'qq');
    ok(!after.euin, "and the other account's euin is not stored");
    r = await call('POST', '/platform-tagging/playlists/annotate', { playlists: [] });
    ok(r.status === 400, 'no uin: refused');

    // --- not tied to 唱卡's mode: taken whatever it is
    await setMode('server');
    r = await call('POST', '/platform-tagging/playlists/qq:777/supply', { uin: '10001', title: null, rows, likedIds: [] });
    ok(r.status === 200, '唱卡 on 网站 IP: QQ打标 supply still taken');
    r = await call('POST', '/platform-tagging/playlists/annotate', { uin: '10001', playlists: [] });
    ok(r.status === 200, '唱卡 on 网站 IP: annotate still taken');

    // --- the server never reads QQ for QQ打标
    r = await call('GET', '/platform-tagging/playlists?platform=qq');
    ok(r.status === 409 && r.body.error.code === 'QQ_USER_IP_ONLY', 'QQ listing by the server: refused');
    r = await call('GET', '/platform-tagging/playlists/qq:999/songs?dirId=3');
    ok(r.status === 409 && r.body.error.code === 'QQ_LIST_NOT_LOADED', 'QQ songs the page has not supplied: refused, not read');
    r = await call('POST', '/platform-tagging/refresh', { playlistRef: 'qq:777', dirId: 3 });
    ok(r.status === 409, 'QQ refresh by the server: refused');

    // --- 网易云打标 is off unless switched on
    r = await call('GET', '/platform-tagging/config');
    ok(r.status === 200 && r.body.netease === false, 'config: NetEase not offered by default');
    r = await call('GET', '/platform-tagging/playlists?platform=netease');
    ok(r.status === 403 && r.body.error.code === 'NETEASE_TAGGING_OFF', 'NetEase listing refused while off');

    // --- the page's own likes: recorded, and its claims checked
    r = await call('POST', '/platform-tagging/user-ip/recorded', { op: 'like', id: '1001', calls: 3 });
    ok(r.status === 200, 'a like the page made is recorded');
    r = await call('POST', '/platform-tagging/user-ip/recorded', { op: 'boom', id: 'x' });
    ok(r.status === 400, 'a malformed record is refused');
    r = await call('POST', '/platform-tagging/user-ip/claim', { cmdId: 'nope' });
    ok(r.status === 409, 'a claim for no command is refused');
    // A page from before (it asked the server to like QQ): told to reload, no write.
    r = await call('POST', '/platform-tagging/like', { platform: 'qq', id: '1001', songType: 0, playlistRef: 'qq:777' });
    ok(r.status === 409 && r.body.error.code === 'QQ_USER_IP_ONLY' && /刷新/.test(r.body.error.message), 'old page QQ heart: 409 reload, not 503');
    r = await call('POST', '/platform-tagging/unlike', { platform: 'qq', id: '1001', songType: 0, playlistRef: 'qq:777' });
    ok(r.status === 409, 'old page QQ unlike: 409 reload');

    // --- in-process: a like made while the browser was reading is not lost
    const uid = user.id;
    const song = (id) => ({ id, songType: 0, mid: null, title: `t${id}`, artist: 'a', durationSec: null, vipOnly: false });
    tags.noteLiked(uid, '2001');
    let out = tags.supplySongs(uid, 'qq:91', { title: 'x', songs: [song('2001'), song('2002')], likedIds: [], readMs: 30000 });
    ok(out.songs.find((x) => x.id === '2001').alreadyLiked === true, 'a like during the read survives the (older) read');
    tags.noteUnliked(uid, '2001');
    out = tags.supplySongs(uid, 'qq:92', { title: 'x', songs: [song('2001')], likedIds: ['2001'], readMs: 30000 });
    ok(out.songs[0].alreadyLiked === false, 'so does an unlike (latest wins)');
    out = tags.supplySongs(uid, 'qq:93', { title: 'x', songs: [song('2001')], likedIds: ['2001'], readMs: 0 });
    ok(out.songs[0].alreadyLiked === false, 'a read with no stated duration still replays the last 5 s');
    for (let i = 0; i < 9; i += 1) tags.supplySongs(uid, `qq:${100 + i}`, { title: 'x', songs: [song('1')], likedIds: [] });
    ok(tags.cachedPlaylistWithLiked(uid, 'qq:91') === null && tags.cachedPlaylistWithLiked(uid, 'qq:108'), 'at most 8 supplied lists per user, oldest dropped');

    console.log(`qq-browser-reads-test: all ${passed} checks passed`);
  } finally {
    if (saved) await prisma.setting.update({ where: { key: saved.key }, data: { value: saved.value } });
    else await prisma.setting.deleteMany({ where: { key: settings.QQ_DIRECT_KEY } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
