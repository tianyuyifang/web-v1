/**
 * platformTagService — the matching → like → record path, with the platform
 * stubbed. Uses the local database for sessions and rows; cleans up after.
 * Run: node tests/platform-tag-test.js
 *
 * The platform layer is replaced in the require cache so no call ever leaves
 * this machine: a like here is a write to a real account, and a test that
 * spends the user's quota against a rate-limited endpoint is not a test.
 */
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// --- Stub the platform layer before anything requires it -----------------
const likePath = require.resolve('../src/services/platformLikeService');
const calls = [];
const stub = {
  PLATFORMS: ['qq', 'netease'],
  parseRef: require(likePath).parseRef,
  songs: [
    { id: '1', songType: 1, title: '达尔文', artist: '蔡健雅' },
    { id: '2', songType: 0, title: '挣脱 (Break Free)', artist: 'Ariana' },
    { id: '3', songType: 0, title: '山海', artist: '草东' },
    { id: '4', songType: 0, title: '山海', artist: '另一人' },
    { id: '5', songType: 0, title: '风雪之恋', artist: 'X' },
  ],
  liked: new Set(['5']),
  failNext: false,
  async getPlaylistSongs(userId, ref) {
    calls.push(['songs', ref]);
    // qq:777 plays the favourites list: it holds only what is liked so far.
    const songs = ref === 'qq:777'
      ? this.songs.filter((s) => this.liked.has(s.id)).map((s) => ({ ...s }))
      : this.songs.map((s) => ({ ...s }));
    return { title: '测试歌单', total: songs.length, songs };
  },
  async likedMap(userId, platform, ids) {
    return new Map(ids.map((id) => [String(id), this.liked.has(String(id))]));
  },
  async like(userId, platform, { id }) {
    calls.push(['like', platform, String(id)]);
    if (this.failNext) { this.failNext = false; throw new Error('平台拒绝'); }
    if (this.liked.has(String(id))) return { ok: true, alreadyLiked: true };
    this.liked.add(String(id));
    return { ok: true, alreadyLiked: false };
  },
  async listPlaylists() { return []; },
  async unlike(userId, platform, { id }) {
    calls.push(['unlike', platform, String(id)]);
    this.liked.delete(String(id));
    return { ok: true };
  },
  QQ_LIKES_DIR_ID: 201,
};
require.cache[likePath].exports = stub;

const prisma = require('../src/db/client');
const tags = require('../src/services/platformTagService');
const captureService = require('../src/services/captureService');

// Guard the same footgun the capture tests guard: never the toggle.
const src = fs.readFileSync(path.join(__dirname, '../src/services/platformTagService.js'), 'utf8');
assert.ok(!/\btoggleLike\b/.test(src), 'platformTagService must not call toggleLike');

(async () => {
  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  assert.ok(user, 'need an ADMIN user');

  const { session } = await captureService.connect({ userId: user.id, label: 'platform-tag-test' });
  try {
    // --- start: aims the connection, reads the playlist once ---------------
    // dirId 512: an ordinary list, not the favourites (201) -- the favourites
    // entry is the one a like drops, which is checked separately below.
    const started = await tags.start({ userId: user.id, playlistRef: 'qq:123', dirId: 512 });
    assert.strictEqual(started.session.target, 'platform');
    assert.strictEqual(started.session.platformRef, 'qq:123');
    assert.strictEqual(started.session.playlistId, null);
    assert.strictEqual(started.playlist.count, 5);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, 1, 'playlist read once at start');

    const fresh = () => prisma.captureSession.findUnique({ where: { id: session.id } });

    // --- exact + unique → liked, and the platform was asked exactly once ---
    let r = await tags.ingest({ session: await fresh(), rawText: '达尔文' });
    assert.strictEqual(r.outcome, 'liked');
    assert.strictEqual(r.likedExternalId, '1');
    assert.strictEqual(r.candidates[0].songType, 1, 'songType carried from the playlist row');
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'like'), [['like', 'qq', '1']]);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, 1, 'cached, not re-read');

    // --- same title again in the same run → duplicate, no second like ------
    r = await tags.ingest({ session: await fresh(), rawText: '达尔文' });
    assert.strictEqual(r.outcome, 'duplicate');
    assert.strictEqual(calls.filter((c) => c[0] === 'like').length, 1);

    // --- exact but already in 我喜欢 → already_liked, no write -------------
    r = await tags.ingest({ session: await fresh(), rawText: '风雪之恋' });
    assert.strictEqual(r.outcome, 'already_liked');
    assert.strictEqual(r.likedExternalId, '5');
    assert.strictEqual(calls.filter((c) => c[0] === 'like').length, 1, 'already-liked answered from the sweep, no platform call');

    // --- bracket match → pending, nothing written ---------------------------
    r = await tags.ingest({ session: await fresh(), rawText: '挣脱' });
    assert.strictEqual(r.outcome, 'pending');
    assert.strictEqual(r.candidates[0].kind, 'bracket');
    assert.strictEqual(r.likedExternalId, null);
    const pendingId = r.eventId;

    // --- two exact candidates → ambiguous, nothing written ------------------
    r = await tags.ingest({ session: await fresh(), rawText: '山海' });
    assert.strictEqual(r.outcome, 'ambiguous');
    assert.strictEqual(r.candidates.length, 2);
    const ambiguousId = r.eventId;

    // --- nothing resembles it → no_match -------------------------------------
    r = await tags.ingest({ session: await fresh(), rawText: '不存在的歌' });
    assert.strictEqual(r.outcome, 'no_match');
    assert.strictEqual(calls.filter((c) => c[0] === 'like').length, 1, 'only the one unliked exact reached the platform');

    // --- the page's list view reads the same cache and sees the new like -----
    const view = await tags.playlistWithLiked(user.id, 'qq:123', 512);
    assert.strictEqual(view.songs.find((x) => x.id === '1').alreadyLiked, true, 'auto-liked song shows as liked');
    assert.strictEqual(view.songs.find((x) => x.id === '2').alreadyLiked, false);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, 1, 'list view served from the run cache');
    assert.ok(view.songs[0].searchText.includes('daerwen') && view.songs[0].searchText.includes('dew'), 'pinyin search text attached');

    // --- a like from elsewhere: every cached list is patched in place ----------
    // The favourites list (dirId 201) gains the row itself; nothing is re-read.
    const fav0 = await tags.playlistWithLiked(user.id, 'qq:777', 201);
    const favRows = fav0.songs.length;
    const readsBefore = calls.filter((c) => c[0] === 'songs').length;
    tags.noteLiked(user.id, '3');
    const again = await tags.playlistWithLiked(user.id, 'qq:123', 512);
    assert.strictEqual(again.songs.find((x) => x.id === '3').alreadyLiked, true, 'heart flipped in the run list without a re-read');
    const fav1 = await tags.playlistWithLiked(user.id, 'qq:777', 201);
    assert.strictEqual(fav1.songs.length, favRows + 1, 'favourites list gained the row in place');
    assert.strictEqual(fav1.songs[0].id, '3', 'newest like sits on top');
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, readsBefore, 'no platform read for any of that');
    tags.noteUnliked(user.id, '3');
    assert.strictEqual((await tags.playlistWithLiked(user.id, 'qq:123', 512)).songs.find((x) => x.id === '3').alreadyLiked, false, 'unlike flips it back');
    assert.strictEqual((await tags.playlistWithLiked(user.id, 'qq:777', 201)).songs.length, favRows, 'favourites row removed in place');
    // A song no cached list knows: the favourites entry goes stale and the
    // page's next open re-reads it -- a run would keep using it meanwhile.
    tags.noteLiked(user.id, '999');
    await tags.playlistWithLiked(user.id, 'qq:777', 201);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, readsBefore + 1, 'stale favourites re-read once on open');
    assert.strictEqual(calls.filter((c) => c[0] === 'songs' && c[1] === 'qq:123').length, 1, 'run list still never re-read');
    tags.dropSongs(user.id, 'qq:777');

    // --- the route's request shaping for a manual like / unlike ---------------
    const { likeTarget } = require('../src/routes/platformTagging');
    assert.deepStrictEqual(likeTarget({ platform: 'qq', id: 5, songType: 1 }), { platform: 'qq', id: '5', songType: 1 });
    assert.deepStrictEqual(likeTarget({ id: '5', playlistRef: 'netease:9' }), { platform: 'netease', id: '5', songType: 0 });
    assert.throws(() => likeTarget({ platform: 'qq', id: '5', playlistRef: 'netease:9' }), /Validation/, 'platform must match the ref');
    assert.throws(() => likeTarget({ platform: 'qq', id: '5', playlistRef: 'qq:' }), /Validation/, 'bad ref refused before any write');

    // --- every service function the router calls must exist ------------------
    // (a renamed export once turned the playlist listing into a 500 that no
    // credential-less smoke test could reach.)
    const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/platformTagging.js'), 'utf8');
    const realLikes = require(likePath);
    for (const [, name] of routeSrc.matchAll(/\btags\.(\w+)\(/g)) assert.strictEqual(typeof tags[name], 'function', `tags.${name} used by the route`);
    for (const [, name] of routeSrc.matchAll(/\blikes\.(\w+)\(/g)) assert.strictEqual(typeof realLikes[name], 'function', `likes.${name} used by the route`);

    // --- approve: ambiguous needs a pick; the pick must be a candidate --------
    await assert.rejects(tags.approve({ userId: user.id, eventId: ambiguousId }), /Validation/);
    await assert.rejects(tags.approve({ userId: user.id, eventId: ambiguousId, externalId: '999' }), /Validation/);
    r = await tags.approve({ userId: user.id, eventId: ambiguousId, externalId: '4' });
    assert.strictEqual(r.outcome, 'liked');
    assert.strictEqual(r.likedExternalId, '4');
    await assert.rejects(tags.approve({ userId: user.id, eventId: ambiguousId, externalId: '4' }), /already been handled/);

    // --- approve a pending row whose like the platform refuses → failed -----
    stub.failNext = true;
    await assert.rejects(tags.approve({ userId: user.id, eventId: pendingId }), /平台拒绝/);
    let row = await prisma.platformTagEvent.findUnique({ where: { id: pendingId } });
    assert.strictEqual(row.outcome, 'failed');
    assert.strictEqual(row.likedExternalId, null);
    // ...and can be retried.
    r = await tags.approve({ userId: user.id, eventId: pendingId });
    assert.strictEqual(r.outcome, 'liked');

    // --- ignore: allowed for anything not liked -----------------------------
    const nm = await prisma.platformTagEvent.findFirst({ where: { sessionId: session.id, outcome: 'no_match' } });
    r = await tags.ignore({ userId: user.id, eventId: nm.id });
    assert.strictEqual(r.outcome, 'ignored');
    await assert.rejects(tags.ignore({ userId: user.id, eventId: pendingId }), /already been liked/);

    // --- another user cannot touch these rows -------------------------------
    await assert.rejects(tags.approve({ userId: '00000000-0000-0000-0000-000000000000', eventId: pendingId }), /not found/);

    // --- feed: everything, oldest first ---------------------------------------
    const feed = await tags.getFeed({ userId: user.id, sessionId: session.id });
    // Five distinct titles: the repeated 达尔文 made no second row.
    assert.strictEqual(feed.events.length, 5);
    assert.strictEqual(feed.events[0].rawText, '达尔文');

    // --- a playlist that cannot be read: 503 to the client, one platform call --
    const before = calls.filter((c) => c[0] === 'songs').length;
    stub.getPlaylistSongs = async () => { calls.push(['songs', 'broken']); const e = new Error('QQ 音乐登录已过期'); e.status = 401; throw e; };
    await prisma.captureSession.update({ where: { id: session.id }, data: { platformRef: 'qq:999' } });
    await assert.rejects(tags.ingest({ session: await fresh(), rawText: '达尔文' }), (e) => e.statusCode === 503 && /登录已过期/.test(e.message));
    await assert.rejects(tags.ingest({ session: await fresh(), rawText: '山海' }), (e) => e.statusCode === 503);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, before + 1, 'the failure is remembered; second capture made no platform call');
    tags.dropSongs(user.id, 'qq:999');

    // --- stop() through this service clears platformRef ----------------------
    await tags.stop({ userId: user.id });
    row = await fresh();
    assert.strictEqual(row.target, 'none');
    assert.strictEqual(row.platformRef, null);
    await prisma.captureSession.update({ where: { id: session.id }, data: { target: 'platform', platformRef: 'qq:123' } });

    // --- re-aim elsewhere clears platformRef; captures then refuse -----------
    await captureService.setTarget({ userId: user.id, target: 'none' });
    row = await fresh();
    assert.strictEqual(row.target, 'none');
    assert.strictEqual(row.platformRef, null);
    await assert.rejects(tags.ingest({ session: row, rawText: '达尔文' }), /No capture target/);

    // --- nothing leaked into capture_events ------------------------------------
    const leaked = await prisma.captureEvent.count({ where: { sessionId: session.id } });
    assert.strictEqual(leaked, 0, 'platform runs must not write capture_events');

    console.log('platform-tag-test: all passed');
  } finally {
    // Cascade removes the platform rows with the session.
    await prisma.captureSession.delete({ where: { id: session.id } }).catch(() => {});
    tags.dropSongs(user.id, 'qq:123');
    await prisma.$disconnect();
  }
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
