/**
 * platformTagService — the matching → like → record path, with the platform
 * stubbed. Uses the local database for sessions and rows; cleans up after.
 * Run: node tests/platform-tag-test.js
 *
 * The platform layer is replaced in the require cache so no call ever leaves
 * this machine: a like here is a write to a real account, and a test that
 * spends the user's quota against a rate-limited endpoint is not a test.
 *
 * Two halves. NetEase keeps the server path (read and like from here), so the
 * matching, caching and approve rules are exercised on a NetEase list. QQ is
 * user-IP only since 2026-10-04: lists come from the page (supplySongs), likes
 * are done by the page or the phone, and the server must never touch QQ --
 * every stub call is recorded and none may name QQ.
 */
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

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
    // netease:777 plays the favourites list: it holds only what is liked so far.
    const songs = ref === 'netease:777'
      ? this.songs.filter((s) => this.liked.has(s.id)).map((s) => ({ ...s }))
      : this.songs.map((s) => ({ ...s }));
    return { title: '测试歌单', total: songs.length, songs };
  },
  async likedMap(userId, platform, ids) {
    calls.push(['likedMap', platform]);
    return new Map(ids.map((id) => [String(id), this.liked.has(String(id))]));
  },
  async like(userId, platform, { id }) {
    calls.push(['like', platform, String(id)]);
    if (this.failNext) { this.failNext = false; throw new Error('平台拒绝'); }
    if (this.liked.has(String(id))) return { ok: true, alreadyLiked: true };
    this.liked.add(String(id));
    return { ok: true, alreadyLiked: false };
  },
  async listPlaylists(userId, platform) { calls.push(['list', platform]); return []; },
  async unlike(userId, platform, { id }) {
    calls.push(['unlike', platform, String(id)]);
    this.liked.delete(String(id));
    return { ok: true };
  },
  QQ_LIKES_DIR_ID: 201,
};
require.cache[likePath].exports = stub;

// The executors' claim checks the user has a QQ account (it hands over no
// credential to a page, only the uin): a fake one, never used against QQ.
const access = require('../src/services/musicCredentialAccess');
const realFresh = access.getFreshCredential;
access.getFreshCredential = async (userId, platform) => (platform === 'qq'
  ? { uin: '10001', musicKey: 'W_Xfake', cookie: 'uin=10001; qm_keyst=W_Xfake' }
  : realFresh(userId, platform));

const prisma = require('../src/db/client');
const tags = require('../src/services/platformTagService');
const apkLikes = require('../src/services/apkLikeService');
const captureService = require('../src/services/captureService');
const settings = require('../src/services/settingsService');

// Guard the same footgun the capture tests guard: never the toggle.
const src = fs.readFileSync(path.join(__dirname, '../src/services/platformTagService.js'), 'utf8');
assert.ok(!/\btoggleLike\b/.test(src), 'platformTagService must not call toggleLike');

const qqCalls = () => calls.filter((c) => (c[1] && String(c[1]).startsWith('qq')) || c[1] === 'qq');
const song = (id, title = `t${id}`) => ({ id, songType: 0, mid: null, title, artist: 'a', durationSec: null, vipOnly: false });

/** A QQ打标 page with its executor stream open, answering offers the way lib/qqTagWrites does. */
function fakePage(userId, { ok = true, alreadyLiked = false, code = 2001 } = {}) {
  const res = new EventEmitter();
  apkLikes.attachPageExecutor(userId, res);
  const done = [];
  const timer = setInterval(async () => {
    for (const cmd of apkLikes._pending.values()) {
      if (cmd.executor !== 'page' || cmd.userId !== userId || cmd.state !== 'sent') continue;
      const job = await apkLikes.claimPage(userId, cmd.id);
      if (!job) continue;
      done.push([job.op, job.id]);
      apkLikes.resultPage(userId, cmd.id, ok ? { ok: true, alreadyLiked, calls: 3 } : { ok: false, code, calls: 2 });
    }
  }, 20);
  return { done, close: () => { clearInterval(timer); res.emit('close'); } };
}

(async () => {
  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  assert.ok(user, 'need an ADMIN user');
  const savedNetease = await prisma.setting.findUnique({ where: { key: settings.NETEASE_TAGGING_KEY } });
  await settings.setNeteaseTagging({ enabled: true });

  // The automatic retries run on real timers; this test checks single passes
  // (qq-tag-background-test covers the retries).
  tags._setAutoRetry({ delays: [] });
  const { session } = await captureService.connect({ userId: user.id, label: 'platform-tag-test' });
  const fresh = () => prisma.captureSession.findUnique({ where: { id: session.id } });
  try {
    // ======================= NetEase: the server path ==========================
    // --- start: aims the connection, reads the playlist once ---------------
    const started = await tags.start({ userId: user.id, playlistRef: 'netease:123' });
    assert.strictEqual(started.session.target, 'platform');
    assert.strictEqual(started.session.platformRef, 'netease:123');
    assert.strictEqual(started.session.playlistId, null);
    assert.strictEqual(started.playlist.count, 5);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, 1, 'playlist read once at start');

    // --- exact + unique → liked, and the platform was asked exactly once ---
    let r = await tags.ingest({ session: await fresh(), rawText: '达尔文' });
    assert.strictEqual(r.outcome, 'liked');
    assert.strictEqual(r.likedExternalId, '1');
    assert.strictEqual(r.candidates[0].songType, 1, 'songType carried from the playlist row');
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'like'), [['like', 'netease', '1']]);
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
    const view = await tags.playlistWithLiked(user.id, 'netease:123', null);
    assert.strictEqual(view.songs.find((x) => x.id === '1').alreadyLiked, true, 'auto-liked song shows as liked');
    assert.strictEqual(view.songs.find((x) => x.id === '2').alreadyLiked, false);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, 1, 'list view served from the run cache');
    assert.ok(view.songs[0].searchText.includes('daerwen') && view.songs[0].searchText.includes('dew'), 'pinyin search text attached');

    // --- a like from elsewhere: every cached list is patched in place ----------
    const fav0 = await tags.playlistWithLiked(user.id, 'netease:777', null, true);
    const favRows = fav0.songs.length;
    const readsBefore = calls.filter((c) => c[0] === 'songs').length;
    tags.noteLiked(user.id, '3');
    const again = await tags.playlistWithLiked(user.id, 'netease:123', null);
    assert.strictEqual(again.songs.find((x) => x.id === '3').alreadyLiked, true, 'heart flipped in the run list without a re-read');
    const fav1 = await tags.playlistWithLiked(user.id, 'netease:777', null, true);
    assert.strictEqual(fav1.songs.length, favRows + 1, 'favourites list gained the row in place');
    assert.strictEqual(fav1.songs[0].id, '3', 'newest like sits on top');
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, readsBefore, 'no platform read for any of that');
    tags.noteUnliked(user.id, '3');
    assert.strictEqual((await tags.playlistWithLiked(user.id, 'netease:123', null)).songs.find((x) => x.id === '3').alreadyLiked, false, 'unlike flips it back');
    assert.strictEqual((await tags.playlistWithLiked(user.id, 'netease:777', null, true)).songs.length, favRows, 'favourites row removed in place');
    tags.noteLiked(user.id, '999');
    await tags.playlistWithLiked(user.id, 'netease:777', null, true);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, readsBefore + 1, 'stale favourites re-read once on open');
    assert.strictEqual(calls.filter((c) => c[0] === 'songs' && c[1] === 'netease:123').length, 1, 'run list still never re-read');
    tags.dropSongs(user.id, 'netease:777');

    // --- the route's request shaping for a manual like / unlike ---------------
    const { likeTarget } = require('../src/routes/platformTagging');
    assert.deepStrictEqual(likeTarget({ platform: 'qq', id: 5, songType: 1 }), { platform: 'qq', id: '5', songType: 1 });
    assert.deepStrictEqual(likeTarget({ id: '5', playlistRef: 'netease:9' }), { platform: 'netease', id: '5', songType: 0 });
    assert.throws(() => likeTarget({ platform: 'qq', id: '5', playlistRef: 'netease:9' }), /Validation/, 'platform must match the ref');
    assert.throws(() => likeTarget({ platform: 'qq', id: '5', playlistRef: 'qq:' }), /Validation/, 'bad ref refused before any write');

    // --- every service function the router calls must exist ------------------
    const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/platformTagging.js'), 'utf8');
    const realLikes = require(likePath);
    for (const [, name] of routeSrc.matchAll(/\btags\.(\w+)\(/g)) assert.strictEqual(typeof tags[name], 'function', `tags.${name} used by the route`);
    for (const [, name] of routeSrc.matchAll(/\blikes\.(\w+)\(/g)) assert.strictEqual(typeof realLikes[name], 'function', `likes.${name} used by the route`);
    for (const [, name] of routeSrc.matchAll(/\bapkLikes\.(\w+)\(/g)) assert.strictEqual(typeof apkLikes[name], 'function', `apkLikes.${name} used by the route`);

    // --- approve: ambiguous needs a pick; the pick must be a candidate --------
    await assert.rejects(tags.approve({ userId: user.id, eventId: ambiguousId }), /Validation/);
    await assert.rejects(tags.approve({ userId: user.id, eventId: ambiguousId, externalId: '999' }), /Validation/);
    r = await tags.approve({ userId: user.id, eventId: ambiguousId, externalId: '4' });
    assert.strictEqual(r.outcome, 'liked');
    assert.strictEqual(r.likedExternalId, '4');
    await assert.rejects(tags.approve({ userId: user.id, eventId: ambiguousId, externalId: '4' }), /已经处理过/);

    // --- approve a pending row whose like the platform refuses → failed -----
    stub.failNext = true;
    await assert.rejects(tags.approve({ userId: user.id, eventId: pendingId }), /平台拒绝/);
    let row = await prisma.platformTagEvent.findUnique({ where: { id: pendingId } });
    assert.strictEqual(row.outcome, 'failed');
    assert.strictEqual(row.likedExternalId, null);
    r = await tags.approve({ userId: user.id, eventId: pendingId });
    assert.strictEqual(r.outcome, 'liked');

    // --- ignore: allowed for anything not liked -----------------------------
    const nm = await prisma.platformTagEvent.findFirst({ where: { sessionId: session.id, outcome: 'no_match' } });
    r = await tags.ignore({ userId: user.id, eventId: nm.id });
    assert.strictEqual(r.outcome, 'ignored');
    await assert.rejects(tags.ignore({ userId: user.id, eventId: pendingId }), /already been liked/);
    await assert.rejects(tags.approve({ userId: '00000000-0000-0000-0000-000000000000', eventId: pendingId }), /not found/);

    // --- feed: everything, oldest first ---------------------------------------
    const feed = await tags.getFeed({ userId: user.id, sessionId: session.id });
    assert.strictEqual(feed.events.length, 5);
    assert.strictEqual(feed.events[0].rawText, '达尔文');

    // --- a NetEase list that cannot be read: 503 to the client, one call -----
    const before = calls.filter((c) => c[0] === 'songs').length;
    const workingSongs = stub.getPlaylistSongs;
    stub.getPlaylistSongs = async () => { calls.push(['songs', 'broken']); const e = new Error('网易云登录已过期'); e.status = 401; throw e; };
    await prisma.captureSession.update({ where: { id: session.id }, data: { platformRef: 'netease:999' } });
    await assert.rejects(tags.ingest({ session: await fresh(), rawText: '达尔文' }), (e) => e.statusCode === 503 && /登录已过期/.test(e.message));
    await assert.rejects(tags.ingest({ session: await fresh(), rawText: '山海' }), (e) => e.statusCode === 503);
    assert.strictEqual(calls.filter((c) => c[0] === 'songs').length, before + 1, 'the failure is remembered; second capture made no platform call');
    tags.dropSongs(user.id, 'netease:999');
    stub.getPlaylistSongs = workingSongs;

    // --- 网易云打标 switched off: nothing written to NetEase ------------------
    await prisma.captureSession.update({ where: { id: session.id }, data: { platformRef: 'netease:123' } });
    await settings.setNeteaseTagging({ enabled: false });
    const likesBeforeOff = calls.filter((c) => c[0] === 'like').length;
    stub.liked.delete('1');
    tags.noteUnliked(user.id, '1');
    await prisma.platformTagEvent.deleteMany({ where: { sessionId: session.id } });
    r = await tags.ingest({ session: await fresh(), rawText: '达尔文' });
    assert.strictEqual(r.outcome, 'pending', 'switched off: an exact NetEase match waits');
    assert.match(r.error || '', /网易云打标暂不提供/);
    await assert.rejects(tags.approve({ userId: user.id, eventId: r.eventId }), /网易云打标暂不提供/);
    assert.strictEqual(calls.filter((c) => c[0] === 'like').length, likesBeforeOff, 'switched off: no NetEase write');
    await settings.setNeteaseTagging({ enabled: true });

    // --- stop() through this service clears platformRef ----------------------
    await tags.stop({ userId: user.id });
    row = await fresh();
    assert.strictEqual(row.target, 'none');
    assert.strictEqual(row.platformRef, null);

    // ======================= QQ: user IP only ==================================
    const qqBefore = qqCalls().length;
    assert.strictEqual(qqBefore, 0, 'nothing so far touched QQ');
    await prisma.platformTagEvent.deleteMany({ where: { sessionId: session.id } });

    // --- a QQ list the page has not supplied cannot be started --------------
    await assert.rejects(tags.start({ userId: user.id, playlistRef: 'qq:123' }), (e) => e.code === 'QQ_LIST_NOT_LOADED');
    // ...nor read for the list view or refreshed by the server.
    await assert.rejects(tags.playlistWithLiked(user.id, 'qq:123', 512), (e) => e.code === 'QQ_LIST_NOT_LOADED');
    await assert.rejects(tags.refresh(user.id, 'qq:123', 512), (e) => e.code === 'QQ_LIST_NOT_LOADED');

    // --- supplied by the page: start works, no QQ call -----------------------
    // Ids of their own: likes noted above (NetEase ids) are noted for every
    // list of the user, whatever the platform.
    const qqSongs = [
      ...stub.songs.map((s) => ({ ...song(s.id, s.title), songType: s.songType, artist: s.artist })),
      song('6', '七里香'),
    ];
    tags.supplySongs(user.id, 'qq:123', { title: 'QQ 歌单', songs: qqSongs.map((x) => ({ ...x })), likedIds: ['5'], dirId: 512 });
    const qs = await tags.start({ userId: user.id, playlistRef: 'qq:123', dirId: 512 });
    assert.strictEqual(qs.playlist.count, 6);

    // --- exact match, no page and no phone: left in 待确认, never the server -----
    r = await tags.ingest({ session: await fresh(), rawText: '达尔文' });
    assert.strictEqual(r.outcome, 'pending', 'nobody to like it: waits for the user');
    assert.match(r.error || '', /网页和手机都不在线/);
    assert.strictEqual(r.likedExternalId, null);
    const waitingId = r.eventId;

    // --- with the page open: the page takes it -----------------------------------
    const page = fakePage(user.id);
    r = await tags.ingest({ session: await fresh(), rawText: '七里香' });
    assert.strictEqual(r.outcome, 'liked', 'the page did the like');
    assert.deepStrictEqual(page.done, [['like', '6']]);
    r = await tags.ingest({ session: await fresh(), rawText: '风雪之恋' });
    assert.strictEqual(r.outcome, 'already_liked', 'known from the supplied liked state');
    assert.strictEqual(page.done.length, 1, 'no offer for a song already liked');

    // --- a page whose write fails for now (QQ's 2001): waits, to be tried again;
    // one whose login is dead (1000): failed, the user has to act. Never the server.
    page.close();
    const refusing = fakePage(user.id, { ok: false, code: 2001 });
    tags.supplySongs(user.id, 'qq:124', { title: 'QQ 歌单 2', songs: [song('31', '晴天'), song('32', '稻香')], likedIds: [] });
    await prisma.captureSession.update({ where: { id: session.id }, data: { platformRef: 'qq:124' } });
    r = await tags.ingest({ session: await fresh(), rawText: '晴天' });
    assert.strictEqual(r.outcome, 'pending', 'QQ 2001 on the page: waits for another try');
    assert.strictEqual(r.autoRetry, true, 'and is marked to be tried again');
    refusing.close();
    const deadLogin = fakePage(user.id, { ok: false, code: 1000 });
    r = await tags.ingest({ session: await fresh(), rawText: '稻香' });
    assert.strictEqual(r.outcome, 'failed', 'dead login (1000): failed, not retried');
    assert.match(r.error || '', /重新扫码/);
    deadLogin.close();
    await prisma.captureSession.update({ where: { id: session.id }, data: { platformRef: 'qq:123' } });

    // --- approve a QQ row: written by the page, only reported here ------------
    await assert.rejects(tags.approve({ userId: user.id, eventId: waitingId }), (e) => e.code === 'QQ_USER_IP_ONLY', 'an old page without the browser write is refused');
    // A refused browser write is recorded as failed (and thrown to the page).
    await assert.rejects(
      tags.approve({ userId: user.id, eventId: waitingId, browserResult: { ok: false, message: 'QQ 未接受（2001）' } }),
      /QQ 未接受/,
    );
    row = await prisma.platformTagEvent.findUnique({ where: { id: waitingId } });
    assert.strictEqual(row.outcome, 'failed');
    r = await tags.approve({ userId: user.id, eventId: waitingId, browserResult: { ok: true, alreadyLiked: false } });
    assert.strictEqual(r.outcome, 'liked', 'a browser write that worked is recorded as liked');
    assert.strictEqual(r.likedExternalId, '1');

    // --- a restart lost the list: captures wait as 'unread', matched on supply --
    tags.dropSongs(user.id, 'qq:123');
    const page2 = fakePage(user.id);
    let u = await tags.ingest({ session: await fresh(), rawText: '山海' });
    assert.strictEqual(u.outcome, 'unread', 'kept, not refused');
    u = await tags.ingest({ session: await fresh(), rawText: '挣脱' });
    assert.strictEqual(u.outcome, 'unread');
    tags.supplySongs(user.id, 'qq:123', { title: 'QQ 歌单', songs: qqSongs.map((x) => ({ ...x })), likedIds: ['1', '5', '6'], dirId: 512 });
    let rows = [];
    for (let i = 0; i < 50; i += 1) {
      rows = await prisma.platformTagEvent.findMany({ where: { sessionId: session.id, rawText: { in: ['山海', '挣脱'] } } });
      if (rows.every((x) => x.outcome !== 'unread')) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.strictEqual(rows.find((x) => x.rawText === '山海').outcome, 'ambiguous', 'rematched once the list is back');
    assert.strictEqual(rows.find((x) => x.rawText === '挣脱').outcome, 'pending', 'rematched: bracket match waits');
    page2.close();

    // --- two supplies at once: each unread capture is liked once, not twice ----
    await prisma.platformTagEvent.deleteMany({ where: { sessionId: session.id } });
    tags.dropSongs(user.id, 'qq:123');
    const page3 = fakePage(user.id);
    // 七里香 was liked above (and that like is replayed onto a fresh supply):
    // unliked again first, as the heart would.
    tags.noteUnliked(user.id, '6');
    u = await tags.ingest({ session: await fresh(), rawText: '七里香' });
    assert.strictEqual(u.outcome, 'unread');
    const unliked = qqSongs.map((x) => ({ ...x }));
    tags.supplySongs(user.id, 'qq:123', { title: 'QQ 歌单', songs: unliked.map((x) => ({ ...x })), likedIds: ['1', '5'], dirId: 512 });
    tags.supplySongs(user.id, 'qq:123', { title: 'QQ 歌单', songs: unliked.map((x) => ({ ...x })), likedIds: ['1', '5'], dirId: 512 });
    let qrow = null;
    for (let i = 0; i < 80; i += 1) {
      qrow = await prisma.platformTagEvent.findFirst({ where: { sessionId: session.id, rawText: '七里香' } });
      if (qrow && !['unread', 'matching'].includes(qrow.outcome)) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.strictEqual(qrow.outcome, 'liked');
    assert.strictEqual(page3.done.filter((d) => d[1] === '6').length, 1, 'rematched once: one like, not two');

    // --- the client gives up waiting and re-sends: one like, one duplicate ------
    await prisma.platformTagEvent.deleteMany({ where: { sessionId: session.id } });
    tags.noteUnliked(user.id, '6');
    const [a1, a2] = await Promise.all([
      tags.ingest({ session: await fresh(), rawText: '七里香' }),
      tags.ingest({ session: await fresh(), rawText: '七里香' }),
    ]);
    assert.deepStrictEqual([a1.outcome, a2.outcome].sort(), ['duplicate', 'liked'], 'a re-sent title is a duplicate');
    assert.strictEqual(page3.done.filter((d) => d[1] === '6').length, 2, 'and liked only once more');
    page3.close();

    // --- a server-side refresh of a QQ list is refused without dropping it ------
    await assert.rejects(tags.refresh(user.id, 'qq:123', 512), (e) => e.code === 'QQ_LIST_NOT_LOADED');
    assert.ok(tags.cachedPlaylistWithLiked(user.id, 'qq:123'), 'the run list is still there');
    assert.ok((await tags.playlistWithLiked(user.id, 'qq:123', 512)).songs.length, 'and served as it is');

    // --- a row a restart left 'matching' (mid-like) is picked up on the next supply
    await prisma.platformTagEvent.deleteMany({ where: { sessionId: session.id } });
    tags.noteUnliked(user.id, '6');
    const stuck = await prisma.platformTagEvent.create({
      data: { sessionId: session.id, userId: user.id, platform: 'qq', playlistRef: 'qq:123', rawText: '七里香', outcome: 'matching' },
    });
    await prisma.$executeRaw`UPDATE platform_tag_events SET updated_at = now() - interval '5 minutes' WHERE id = ${stuck.id}::uuid`;
    const page4 = fakePage(user.id);
    tags.supplySongs(user.id, 'qq:123', { title: 'QQ 歌单', songs: qqSongs.map((x) => ({ ...x })), likedIds: ['1', '5'], dirId: 512 });
    let st = null;
    for (let i = 0; i < 80; i += 1) {
      st = await prisma.platformTagEvent.findUnique({ where: { id: stuck.id } });
      if (st.outcome !== 'matching') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.strictEqual(st.outcome, 'liked', "a row stranded 'matching' is matched again, not lost");
    // ...but one still being worked on (recent) is left alone.
    const recent = await prisma.platformTagEvent.create({
      data: { sessionId: session.id, userId: user.id, platform: 'qq', playlistRef: 'qq:123', rawText: '甲乙丙', outcome: 'matching' },
    });
    tags.supplySongs(user.id, 'qq:123', { title: 'QQ 歌单', songs: qqSongs.map((x) => ({ ...x })), likedIds: ['1', '5', '6'], dirId: 512 });
    await new Promise((res) => setTimeout(res, 500));
    assert.strictEqual((await prisma.platformTagEvent.findUnique({ where: { id: recent.id } })).outcome, 'matching', 'a fresh matching row is not taken over');
    page4.close();

    // --- unread captures of a list the run left are settled -------------------
    tags.dropSongs(user.id, 'qq:123');
    u = await tags.ingest({ session: await fresh(), rawText: '晴天' });
    assert.strictEqual(u.outcome, 'unread');
    tags.supplySongs(user.id, 'qq:501', { title: 'other', songs: [song('9')], likedIds: [] });
    await tags.start({ userId: user.id, playlistRef: 'qq:501', dirId: 512 });
    const settled = await prisma.platformTagEvent.findUnique({ where: { id: u.eventId } });
    assert.strictEqual(settled.outcome, 'no_match', 'left behind: settled, not waiting forever');

    // --- after all of it: the server never touched QQ --------------------------
    assert.deepStrictEqual(qqCalls(), [], 'no read, like or listing of QQ from the server');

    // --- a run's list supplied by the browser survives browsing 8 others --------
    tags.supplySongs(user.id, 'qq:500', { title: 'run', songs: [song('1')], likedIds: [] });
    await tags.start({ userId: user.id, playlistRef: 'qq:500', dirId: 512 });
    for (let i = 0; i < 9; i += 1) tags.supplySongs(user.id, `qq:${600 + i}`, { title: 'x', songs: [song('2')], likedIds: [] });
    assert.ok(tags.cachedPlaylistWithLiked(user.id, 'qq:500'), "the run's list is not evicted");
    assert.strictEqual(tags.cachedPlaylistWithLiked(user.id, 'qq:600'), null, 'the oldest browsed list is');
    await tags.stop({ userId: user.id });
    assert.ok(tags.cachedPlaylistWithLiked(user.id, 'qq:500'), 'stop keeps lists the browser supplied');

    // --- a server-read (NetEase) entry is never evicted by browser supplies -----
    await tags.refresh(user.id, 'netease:700', null);
    for (let i = 0; i < 9; i += 1) tags.supplySongs(user.id, `qq:${800 + i}`, { title: 'x', songs: [song('4')], likedIds: [] });
    assert.ok(tags.cachedPlaylistWithLiked(user.id, 'netease:700'), 'a server-read entry is never evicted by browser supplies');

    // --- nothing leaked into capture_events ------------------------------------
    const leaked = await prisma.captureEvent.count({ where: { sessionId: session.id } });
    assert.strictEqual(leaked, 0, 'platform runs must not write capture_events');

    console.log('platform-tag-test: all passed');
  } finally {
    // Cascade removes the platform rows with the session.
    await prisma.captureSession.delete({ where: { id: session.id } }).catch(() => {});
    tags.dropSongs(user.id, 'qq:123');
    tags.dropSongs(user.id, 'netease:123');
    if (savedNetease) await prisma.setting.update({ where: { key: savedNetease.key }, data: { value: savedNetease.value } });
    else await prisma.setting.deleteMany({ where: { key: settings.NETEASE_TAGGING_KEY } });
    await prisma.$disconnect();
  }
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
