/**
 * The v28 capture-client work, server side:
 *   A. which round a title belongs to (captureRouting), pure
 *   B. /ingest and /heartbeat over HTTP against a running backend
 *   C. QQ likes performed by the phone (apkLikeService), platform stubbed --
 *      never by the server since 2026-10-04: with no page or phone to take
 *      a like, it is refused (NO_USER_IP_EXECUTOR), not done from here
 *   D. the 歌P singer library and its 待确认 suggestions
 *
 * Run: node tests/apk-capture-test.js   (B needs a backend on TEST_BASE,
 * default http://localhost:4300, using the same database)
 *
 * The platform layer and the credential store are replaced in the require
 * cache, as in platform-tag-test: nothing here ever reaches QQ.
 */
require('dotenv').config();
const assert = require('assert');
const { EventEmitter } = require('events');

// --- stubs, before anything requires the real modules -----------------------
const likePath = require.resolve('../src/services/platformLikeService');
const calls = [];
const stub = {
  PLATFORMS: ['qq', 'netease'],
  parseRef: require(likePath).parseRef,
  songs: [
    { id: '11', songType: 1, title: '晴天', artist: '周杰伦' },
    { id: '12', songType: 0, title: '七里香', artist: '周杰伦' },
    { id: '13', songType: 0, title: 'Can You Feel My World (Live)', artist: '王力宏' },
    { id: '14', songType: 0, title: '大城小爱', artist: '王力宏' },
  ],
  liked: new Set(),
  async getPlaylistSongs() {
    return { title: '测试歌单', total: this.songs.length, songs: this.songs.map((s) => ({ ...s })) };
  },
  async likedMap(userId, platform, ids) {
    return new Map(ids.map((id) => [String(id), this.liked.has(String(id))]));
  },
  async like(userId, platform, { id }) {
    calls.push(['server-like', platform, String(id)]);
    const already = this.liked.has(String(id));
    this.liked.add(String(id));
    return { ok: true, alreadyLiked: already };
  },
  async unlike(userId, platform, { id }) {
    calls.push(['server-unlike', platform, String(id)]);
    this.liked.delete(String(id));
    return { ok: true };
  },
  async listPlaylists() { return []; },
  QQ_LIKES_DIR_ID: 201,
};
require.cache[likePath].exports = stub;

const accessPath = require.resolve('../src/services/musicCredentialAccess');
const realAccess = require(accessPath);
const credStub = { have: true };
require.cache[accessPath].exports = {
  ...realAccess,
  async getFreshCredential() {
    return credStub.have ? { cookie: 'qm_keyst=W_Xtest; uin=123', uin: '123', musicKey: 'W_Xtest' } : null;
  },
};

const prisma = require('../src/db/client');
const settingsService = require('../src/services/settingsService');
const captureService = require('../src/services/captureService');
const { misrouted, clientTarget } = require('../src/services/captureRouting');
const apkChannel = require('../src/services/apkChannel');
const apkLikes = require('../src/services/apkLikeService');
const tags = require('../src/services/platformTagService');
const gep = require('../src/services/gepSingerService');

const BASE = process.env.TEST_BASE || 'http://localhost:4300';
const SINGER_PREFIX = '__apk_test_';
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed += 1; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed += 1; }

async function post(path, token, body) {
  const res = await fetch(`${BASE}/api/capture${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Capture-Token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A response object that records SSE frames, for apkChannel.attach. */
function fakeStream() {
  const r = new EventEmitter();
  r.frames = [];
  r.writeHead = () => {};
  r.write = (s) => { r.frames.push(s); r.emit('frame', s); return true; };
  r.end = () => r.emit('close');
  return r;
}
function framesOf(r, event) {
  return r.frames
    .filter((f) => f.startsWith(`event: ${event}\n`))
    .map((f) => JSON.parse(f.split('\ndata: ')[1]));
}

(async () => {
  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  ok(user, 'need an ADMIN user');
  const savedSetting = await prisma.setting.findUnique({ where: { key: settingsService.APK_LIKES_KEY } });
  const created = { playlists: [], sessions: [] };

  try {
    // ======================================================================
    // A. captureRouting
    // ======================================================================
    const gepT = '《晴天》';
    const liveT = '晴天-周杰伦';
    eq(misrouted({ target: 'live', from: null, text: gepT }), true, 'old client: 《》 under 唱卡 is 歌P');
    eq(misrouted({ target: 'live', from: null, text: liveT }), false, 'old client: 唱卡 title under 唱卡 passes');
    eq(misrouted({ target: 'live', from: null, text: '晴天' }), false, 'bare title under 唱卡 passes');
    eq(misrouted({ target: 'live', from: 'gep', text: '晴天' }), true, 'v28: from=gep under 唱卡 refused');
    eq(misrouted({ target: 'live', from: 'live', text: liveT }), false, 'v28: from=live under 唱卡 passes');
    eq(misrouted({ target: 'playlist', from: null, text: liveT }), true, 'old client: title-artist under 歌单 is 唱卡');
    eq(misrouted({ target: 'platform', from: null, text: liveT }), true, 'old client: title-artist under QQ打标 is 唱卡');
    eq(misrouted({ target: 'playlist', from: null, text: gepT }), false, '《》 under 歌单 passes');
    eq(misrouted({ target: 'playlist', from: null, text: '《Lost-你的名字》' }), false, 'a dash inside 《》 is still 歌P');
    eq(misrouted({ target: 'playlist', from: null, text: '晴天' }), false, 'bare title under 歌单 passes (as before)');
    eq(misrouted({ target: 'playlist', from: 'live', text: '晴天' }), true, 'v28: from=live under 歌单 refused');
    eq(misrouted({ target: 'platform', from: 'gep', text: gepT }), false, 'v28: from=gep under QQ打标 passes');
    eq(misrouted({ target: 'none', from: 'gep', text: gepT }), false, 'none is left to its own 409');
    eq(misrouted({ target: 'live', from: 'live', text: '《odd》-x' }), false, 'v28: from is believed over the shape (live)');
    eq(misrouted({ target: 'playlist', from: 'gep', text: 'odd-x' }), false, 'v28: from is believed over the shape (gep)');

    eq(clientTarget({ target: 'playlist', playlistId: 'p1', platformRef: null }),
      { target: 'playlist', playlistId: 'p1', realTarget: 'playlist', platform: null }, 'playlist target');
    eq(clientTarget({ target: 'platform', playlistId: null, platformRef: 'qq:9' }),
      { target: 'playlist', playlistId: 'qq:9', realTarget: 'platform', platform: 'qq' }, 'platform reported as playlist + ref');
    eq(clientTarget({ target: 'live', playlistId: null, platformRef: null }),
      { target: 'live', playlistId: null, realTarget: 'live', platform: null }, 'live target');

    // ======================================================================
    // B. /ingest and /heartbeat over HTTP (apkLikes at its default: off)
    // ======================================================================
    await prisma.setting.deleteMany({ where: { key: settingsService.APK_LIKES_KEY } });
    const { session, token } = await captureService.connect({ userId: user.id, label: 'apk-capture-test' });
    created.sessions.push(session.id);

    const clip = await prisma.clip.findFirst({ include: { song: { select: { id: true, title: true, artist: true } } } });
    ok(clip && clip.song, 'need a clip with a song');
    const playlist = await prisma.playlist.create({ data: { name: `__apk_test_${Date.now()}`, userId: user.id } });
    created.playlists.push(playlist.id);
    await prisma.playlistClip.create({ data: { playlistId: playlist.id, clipId: clip.id, position: 0 } });

    // -- aimed at 唱卡
    await captureService.setTarget({ userId: user.id, target: 'live' });
    let hb = await post('/heartbeat', token, { clientVersion: 27 });
    eq(hb.status, 200, 'heartbeat ok');
    eq([hb.body.target, hb.body.playlistId, hb.body.realTarget, hb.body.platform, hb.body.stream],
      ['live', null, 'live', null, false], 'heartbeat under 唱卡: same target/playlistId as before, no stream');

    const countLive = () => prisma.captureEvent.count({ where: { sessionId: session.id } });
    const before = await countLive();
    let r = await post('/ingest', token, { text: '《__apk晴天》', side: 'red', row: 3, stage: 'picking' });
    eq([r.status, r.body.outcome], [200, 'wrong_mode'], 'v27 歌P title under 唱卡 → wrong_mode, 200');
    eq([r.body.target, r.body.realTarget], ['live', 'live'], 'wrong_mode carries the current target');
    r = await post('/ingest', token, { text: `__apk晴天${RUN}`, from: 'gep', singer: `${SINGER_PREFIX}周杰伦` });
    eq(r.body.outcome, 'wrong_mode', 'v28 from=gep under 唱卡 → wrong_mode');
    eq(await countLive(), before, 'nothing stored for misrouted titles');
    // The pair is still a fact about the game.
    await sleep(300);
    ok(await prisma.gepSingerSong.findUnique({
      where: { singer_title: { singer: `${SINGER_PREFIX}周杰伦`, title: `__apk晴天${RUN}` } },
    }), 'singer pair recorded even when misrouted');

    r = await post('/ingest', token, { text: '__apk不存在的歌-__apk歌手', stage: 'picking' });
    ok(['resolved', 'unmapped'].includes(r.body.outcome), `唱卡 title under 唱卡 goes through (${r.body.outcome})`);
    eq(await countLive(), before + 1, 'and is stored');

    // -- aimed at a playlist
    await captureService.setTarget({ userId: user.id, target: 'playlist', playlistId: playlist.id });
    hb = await post('/heartbeat', token, {});
    eq([hb.body.target, hb.body.playlistId, hb.body.realTarget, hb.body.stream],
      ['playlist', playlist.id, 'playlist', false], 'heartbeat under 歌单 unchanged');
    r = await post('/ingest', token, { text: '离歌-信乐团', stage: 'picking' });
    eq(r.body.outcome, 'wrong_mode', 'v27 唱卡 title under 歌单 → wrong_mode (was liked/proposed before)');
    eq(r.body.playlistId, playlist.id, 'wrong_mode names the playlist');
    r = await post('/ingest', token, { text: '__apk sing', from: 'live' });
    eq(r.body.outcome, 'wrong_mode', 'v28 from=live under 歌单 → wrong_mode');
    r = await post('/ingest', token, { text: `《${clip.song.title}》`, side: 'blue', row: 0 });
    ok(!['wrong_mode', 'duplicate'].includes(r.body.outcome), `v27 歌P title under 歌单 goes through (${r.body.outcome})`);
    r = await post('/ingest', token, { text: '《__apk_nothing_like_this》', from: 'gep', singer: `${SINGER_PREFIX}A` });
    eq(r.body.outcome, 'no_match', 'v28 歌P title with no alias: no_match as before');

    // -- aimed at nothing: the old 409, misrouted or not
    await captureService.setTarget({ userId: user.id, target: 'none' });
    r = await post('/ingest', token, { text: '《x》', from: 'live' });
    eq(r.status, 409, 'target none still refuses with 409');

    // ======================================================================
    // C. likes by the phone
    // ======================================================================
    // The server never reads QQ: the list comes from the page.
    tags.supplySongs(user.id, 'qq:4242', { title: '测试歌单', songs: stub.songs.map((x) => ({ ...x })), likedIds: [], dirId: 512 });
    const started = await tags.start({ userId: user.id, playlistRef: 'qq:4242', dirId: 512 });
    const noExecutor = (e) => e.code === 'NO_USER_IP_EXECUTOR';
    const platSession = started.session;

    // targetFor: no stream while the switch is off
    let tf = await apkChannel.targetFor(platSession);
    eq([tf.target, tf.playlistId, tf.realTarget, tf.platform, tf.stream],
      ['playlist', 'qq:4242', 'platform', 'qq', false], 'QQ打标, switch off: no stream');

    // switch off → no stream at all, and nobody to like it: refused, never the server
    const refused = fakeStream();
    eq(await apkChannel.attach(platSession, refused, { version: 28, caps: [apkLikes.CAP] }), false, 'switch off: stream refused');
    eq(refused.frames.length, 0, 'and nothing written to it');
    calls.length = 0;
    await assert.rejects(apkLikes.like(user.id, 'qq', { id: '12', songType: 0 }, { purpose: 'auto', session: platSession }), noExecutor);
    eq(calls, [], 'switch off, no page: refused, the server does not do it');
    let res;

    await settingsService.setApkLikes({ enabled: true, adminsOnly: true, auto: false, approve: false, manual: false });
    tf = await apkChannel.targetFor(platSession);
    eq(tf.stream, true, 'QQ打标 on QQ, switch on, admin: stream');
    const phone = fakeStream();
    eq(await apkChannel.attach(platSession, phone, { version: 28, caps: [apkLikes.CAP] }), true, 'stream accepted');
    eq(framesOf(phone, 'target').length, 1, 'attach sends the current target first');
    calls.length = 0;
    await assert.rejects(apkLikes.like(user.id, 'qq', { id: '12', songType: 0 }, { purpose: 'auto', session: platSession }), noExecutor);
    eq([calls, framesOf(phone, 'cmd').length], [[], 0], 'switch on but 自动点赞 off: nothing sent, not the server');
    await settingsService.setApkLikes({ auto: true });

    // The phone: claim, then report. Behaviour set per case.
    const phoneMode = { claim: true, report: 'ok', claimDelay: 0, seen: [] };
    phone.on('frame', (f) => {
      if (!f.startsWith('event: cmd\n')) return;
      const { cmdId, op } = JSON.parse(f.split('\ndata: ')[1]);
      phoneMode.seen.push(op);
      (async () => {
        if (!phoneMode.claim) return;
        await sleep(phoneMode.claimDelay);
        const job = await apkLikes.claim(platSession, cmdId);
        phoneMode.lastJob = job;
        if (!job) return;
        if (phoneMode.report === 'none') return;
        if (phoneMode.report === 'ok') apkLikes.result(platSession, cmdId, { ok: true, alreadyLiked: false, calls: 2 });
        else apkLikes.result(platSession, cmdId, { ok: false, code: phoneMode.failCode || 1000, calls: 1 });
      })();
    });

    calls.length = 0;
    let t0 = Date.now();
    res = await apkLikes.like(user.id, 'qq', { id: '12', songType: 0, knownUnliked: true }, { purpose: 'auto', session: platSession });
    eq(res, { ok: true, alreadyLiked: false }, 'phone did the like');
    eq(calls, [], 'server never wrote');
    ok(phoneMode.lastJob && phoneMode.lastJob.cred.cookie && phoneMode.lastJob.id === '12' && phoneMode.lastJob.precheck === false,
      'claim hands over credential + song; auto skips the pre-check');
    ok(Date.now() - t0 < 1000, 'and quickly');

    // unclaimed → refused after CLAIM_MS (never the server); a late claim is refused
    phoneMode.claim = false;
    calls.length = 0;
    t0 = Date.now();
    await assert.rejects(apkLikes.like(user.id, 'qq', { id: '11', songType: 1, knownUnliked: true }, { purpose: 'auto', session: platSession }), noExecutor);
    const waited = Date.now() - t0;
    eq(calls, [], 'unclaimed: not the server');
    ok(waited >= apkLikes.CLAIM_MS - 50 && waited < apkLikes.CLAIM_MS + 1500, `unclaimed waited ~${waited}ms`);
    eq(apkLikes._pending.size, 0, 'no command left in flight');
    stub.liked.clear();

    // claimed, then a dead login reported (1000) → refused for good, the user has to rescan
    phoneMode.claim = true;
    phoneMode.report = 'fail';
    calls.length = 0;
    await assert.rejects(
      apkLikes.like(user.id, 'qq', { id: '14', songType: 0 }, { purpose: 'auto', session: platSession }),
      (e) => noExecutor(e) && e.tried.includes('phone:refused') && apkLikes.isPermanentFailure(e) && /重新扫码/.test(e.message),
    );
    // ...and a failure for now (the phone lost its connection) → worth another try
    phoneMode.failCode = 'network';
    await assert.rejects(
      apkLikes.like(user.id, 'qq', { id: '14', songType: 0 }, { purpose: 'auto', session: platSession }),
      (e) => noExecutor(e) && e.tried.includes('phone:failed') && !apkLikes.isPermanentFailure(e)
        && e.message.startsWith(apkLikes.NO_EXECUTOR_PREFIX),
    );
    phoneMode.failCode = null;
    eq(calls, [], 'phone failure: not the server');
    eq(phoneMode.lastJob.precheck, true, 'a like the caller has not checked is pre-checked by the phone');
    stub.liked.clear();

    // claimed, never reports → refused after RESULT_MS
    phoneMode.report = 'none';
    calls.length = 0;
    t0 = Date.now();
    await assert.rejects(apkLikes.like(user.id, 'qq', { id: '13', songType: 0 }, { purpose: 'auto', session: platSession }), noExecutor);
    eq(calls, [], 'no result: not the server');
    ok(Date.now() - t0 >= apkLikes.RESULT_MS - 50, 'after the result window');
    stub.liked.clear();

    // no credential at claim → claim refused, and so is the like
    phoneMode.report = 'ok';
    credStub.have = false;
    calls.length = 0;
    await assert.rejects(apkLikes.like(user.id, 'qq', { id: '12', songType: 0 }, { purpose: 'auto', session: platSession }), noExecutor);
    eq(calls, [], 'no credential: not the server');
    eq(phoneMode.lastJob, null, 'claim refused');
    credStub.have = true;
    stub.liked.clear();

    // approve / manual switched off: QQ refused (never the server); NetEase: the server
    phoneMode.seen.length = 0;
    calls.length = 0;
    await assert.rejects(apkLikes.like(user.id, 'qq', { id: '12' }, { purpose: 'approve' }), noExecutor);
    await assert.rejects(apkLikes.unlike(user.id, 'qq', { id: '12' }, { purpose: 'manual' }), noExecutor);
    await apkLikes.like(user.id, 'netease', { id: '99' }, { purpose: 'auto', session: platSession });
    eq(phoneMode.seen, [], 'approve/manual switched off and NetEase: never sent to the phone');
    eq(calls.map((c) => c[0]), ['server-like'], 'only NetEase by the server');
    stub.liked.clear();

    // manual on: unlike goes to the phone, finding the session by itself
    await settingsService.setApkLikes({ manual: true });
    phoneMode.seen.length = 0;
    calls.length = 0;
    res = await apkLikes.unlike(user.id, 'qq', { id: '12', songType: 1 }, { purpose: 'manual' });
    eq([res, phoneMode.seen, calls], [{ ok: true }, ['unlike'], []], 'manual unlike by the phone');

    // a claim from another session is refused
    {
      const job = await apkLikes.claim({ id: '00000000-0000-0000-0000-000000000000' }, 'nope');
      eq(job, null, 'unknown command / other session refused');
    }

    // the whole auto path through ingest: exact single match → phone likes it
    phoneMode.seen.length = 0;
    calls.length = 0;
    const ing = await tags.ingest({ session: platSession, rawText: '《七里香》', singer: null });
    eq([ing.outcome, ing.likedExternalId, phoneMode.seen, calls], ['liked', '12', ['like'], []],
      'ingest: exact match liked by the phone');

    // stream closed → nobody to take it: refused, never the server
    phone.end();
    await sleep(50);
    calls.length = 0;
    await assert.rejects(apkLikes.like(user.id, 'qq', { id: '14' }, { purpose: 'auto', session: platSession }), noExecutor);
    eq(calls, [], 'stream gone: not the server');
    stub.liked.clear();

    // pushTarget: a stream open on this session hears a switch at once
    {
      const p2 = fakeStream();
      eq(await apkChannel.attach(platSession, p2, { version: 28, caps: [apkLikes.CAP] }), true, 'reattach');
      await captureService.setTarget({ userId: user.id, target: 'live' });
      await sleep(100);
      const ts = framesOf(p2, 'target');
      eq(ts[ts.length - 1].realTarget, 'live', 'switch to 唱卡 pushed at once');
      eq(ts[ts.length - 1].stream, false, 'and tells the client to close the stream');
      p2.end();
    }

    // non-admin with adminsOnly → no stream, server path
    {
      const member = await prisma.user.findFirst({ where: { role: 'MEMBER' } });
      if (member) {
        const fake = { id: platSession.id, userId: member.id, target: 'platform', platformRef: 'qq:1' };
        eq(await apkChannel.wantsStream(fake), false, 'adminsOnly: members get no stream');
      }
    }

    // ======================================================================
    // D. singer library
    // ======================================================================
    const S = `${SINGER_PREFIX}王力宏`;
    const added = await gep.addSong(S, '《CYFMW》');
    eq(added.title, 'CYFMW', '《》 stripped on add');
    eq((await gep.addSong(S, 'CYFMW')).id, added.id, 'adding again returns the same row');
    const alias = await gep.addAlias(added.id, 'Can You Feel My World (Live)');
    eq((await gep.listSongs(S)).songs[0].aliases.map((a) => a.siteTitle), ['Can You Feel My World (Live)'], 'alias listed');
    ok((await gep.listSingers({ query: SINGER_PREFIX })).singers.some((s) => s.singer === S && s.songs === 1), 'singer listed with count');
    ok((await gep.listSingers({ query: 'cyfm' })).singers.some((s) => s.singer === S), 'search by title finds the singer (case-insensitive)');

    // QQ打标: no match on its own, the alias proposes it -- never liked unasked
    await tags.start({ userId: user.id, playlistRef: 'qq:4242', dirId: 512 });
    calls.length = 0;
    const viaAlias = await tags.ingest({ session: platSession, rawText: '《CYFMW》', singer: S });
    eq(viaAlias.outcome, 'pending', 'alias turns no_match into 待确认');
    eq([viaAlias.candidates.length, viaAlias.candidates[0].externalId, viaAlias.candidates[0].kind], [1, '13', 'alias'], 'the aliased song, kind alias');
    eq(calls, [], 'and nothing was liked');
    const noSinger = await tags.ingest({ session: platSession, rawText: '《CYFMW》', singer: null });
    eq(noSinger.outcome, 'duplicate', '(same text dedupes as before)');
    const otherSinger = await tags.ingest({ session: platSession, rawText: '《CYFMW》x', singer: `${SINGER_PREFIX}别人` });
    eq(otherSinger.outcome, 'no_match', 'another singer: no alias, no_match');

    // 歌单: the alias proposes the playlist's clip, kind alias, never 'exact'
    await captureService.setTarget({ userId: user.id, target: 'playlist', playlistId: playlist.id });
    const S2 = `${SINGER_PREFIX}clip`;
    const song2 = await gep.addSong(S2, '__apk游戏里的名字');
    await gep.addAlias(song2.id, clip.song.title);
    const freshSession = await prisma.captureSession.findUnique({ where: { id: session.id } });
    const viaAlias2 = await captureService.ingestText({ session: freshSession, rawText: '《__apk游戏里的名字》', singer: S2 });
    ok(['pending', 'ambiguous'].includes(viaAlias2.outcome), `歌单 alias → ${viaAlias2.outcome}`);
    ok(viaAlias2.candidates.every((c) => c.kind === 'alias'), 'candidates are kind alias');
    ok(viaAlias2.candidates.some((c) => c.clips.some((cl) => cl.clipId === clip.id)), 'the playlist clip is offered');
    const plain = await captureService.ingestText({ session: freshSession, rawText: '《__apk游戏里的名字2》', singer: null });
    eq(plain.outcome, 'no_match', 'without a singer: no_match as before');

    // delete: alias, then song (cascade)
    await gep.deleteAlias(alias.id);
    eq((await gep.listSongs(S)).songs[0].aliases, [], 'alias deleted');
    await gep.addAlias(added.id, 'x');
    await gep.deleteSong(added.id);
    eq(await prisma.gepSongAlias.count({ where: { singerSongId: added.id } }), 0, 'song delete cascades to aliases');
    await assert.rejects(gep.deleteSong(added.id), /not found/i, 'deleting twice is a 404');

    // ======================================================================
    // E. 方案 C (2026-10-11): a 网站歌名 match is liked on its own only when it
    //    is one song credited to the game's singer; and 待处理 marks
    // ======================================================================
    const flagOf = async (singer, title) => (await prisma.gepSingerSong.findUnique({
      where: { singer_title: { singer, title } }, select: { needsReviewAt: true },
    }))?.needsReviewAt || null;
    // No underscore: on the site "_" separates artists, so a prefixed name would never read as credited.
    const SA = 'apkTest歌手甲';
    // QQ打标's 待处理 is judged against the site catalogue alone (2026-10-11).
    const { matchTitle: mt } = require('../src/services/captureMatchService');
    const siteExact = async (title) => mt(`《${title}》`, await captureService.fetchCandidateSongs(`《${title}》`)).candidates.some((c) => c.kind === 'exact');
    stub.songs.push({ id: '15', songType: 0, title: '__apk网站上的名字', artist: SA });
    stub.songs.push({ id: '16', songType: 0, title: '__apk别人唱的', artist: '__apk路人' });
    stub.songs.push({ id: '17', songType: 0, title: '__apk近似歌 (Live)', artist: SA });
    stub.songs.push({ id: '18', songType: 0, title: '__apk同名', artist: '__apk甲' });
    stub.songs.push({ id: '19', songType: 0, title: '__apk同名', artist: '__apk乙' });
    tags.supplySongs(user.id, 'qq:4343', { title: '测试歌单2', songs: stub.songs.map((x) => ({ ...x })), likedIds: [], dirId: 513 });
    await tags.start({ userId: user.id, playlistRef: 'qq:4343', dirId: 513 });
    phoneMode.claim = true; phoneMode.report = 'ok'; phoneMode.claimDelay = 0;

    const ga = await gep.addSong(SA, '__apk游戏名甲');
    await gep.addAlias(ga.id, '__apk网站上的名字');
    phoneMode.lastJob = null;
    const credited = await tags.ingest({ session: platSession, rawText: '《__apk游戏名甲》', singer: SA });
    // Taken as an auto-like: done by the phone when one is there, else waiting
    // to be retried on its own -- exactly what a perfect match gets.
    ok(credited.outcome === 'liked' || (credited.outcome === 'pending' && credited.autoRetry === true),
      `QQ: one song via 网站歌名, singer credited → auto-liked (${credited.outcome}, autoRetry ${credited.autoRetry})`);
    if (credited.outcome === 'liked') eq(phoneMode.lastJob && phoneMode.lastJob.id, '15', 'the aliased song was the one liked');
    eq([credited.candidates[0].kind, credited.candidates[0].auto], ['alias', true], 'kind alias, marked auto');
    await sleep(200);
    await sleep(300);
    ok(await flagOf(SA, '__apk游戏名甲'), 'QQ: its 网站歌名 names nothing on the site → 待处理 (judged by the site, not the QQ list)');

    const gb = await gep.addSong(SA, '__apk游戏名乙');
    await gep.addAlias(gb.id, '__apk别人唱的');
    phoneMode.lastJob = null;
    const uncredited = await tags.ingest({ session: platSession, rawText: '《__apk游戏名乙》', singer: SA });
    eq(uncredited.outcome, 'pending', 'QQ: 网站歌名 finds a song not credited to the singer → 待确认');
    eq(phoneMode.lastJob, null, 'and nothing was liked');
    eq(uncredited.candidates[0].auto, undefined, 'not marked auto');
    eq(uncredited.autoRetry, false, 'not an auto-like waiting to be retried');
    await sleep(200);
    await sleep(300);
    ok(await flagOf(SA, '__apk游戏名乙'), 'QQ: 网站歌名 naming nothing on the site → 待处理');

    phoneMode.lastJob = null;
    const perfect = await tags.ingest({ session: platSession, rawText: '《七里香》', singer: SA });
    ok(['liked', 'already_liked'].includes(perfect.outcome), `QQ: a perfect title match is liked exactly as before (${perfect.outcome})`);
    eq(perfect.candidates[0].kind, 'exact', 'kind exact');
    eq(perfect.candidates[0].auto, undefined, 'no auto marker on a plain exact match');
    await sleep(200);
    await sleep(300);
    eq(Boolean(await flagOf(SA, '七里香')), !(await siteExact('七里香')), 'QQ perfect in the list: 待处理 only if the site lacks the title');

    const near = await tags.ingest({ session: platSession, rawText: '《大城小爱 (Live)》', singer: SA });
    eq(near.outcome, 'pending', 'QQ: a near title (bracket) waits as before');
    await sleep(300);
    eq(Boolean(await flagOf(SA, '大城小爱 (Live)')), !(await siteExact('大城小爱 (Live)')), 'QQ near: 待处理 iff the site lacks the title');

    const none = await tags.ingest({ session: platSession, rawText: '《__apk哪里都没有的歌》', singer: SA });
    eq(none.outcome, 'no_match', 'QQ: nothing anywhere → no_match');
    eq((await prisma.platformTagEvent.findUnique({ where: { id: none.eventId } })).candidates, null,
      'QQ: the singer placeholder carried while matching does not stay on the row');
    await sleep(500);
    ok(await flagOf(SA, '__apk哪里都没有的歌'), 'no match, not on the site either: 待处理');

    // the title is right on the site, just not in this QQ list: nothing a 网站歌名 would fix
    const absent = await tags.ingest({ session: platSession, rawText: `《${clip.song.title}》`, singer: SA });
    eq(absent.outcome, 'no_match', 'QQ: a site title missing from the QQ list → no_match');
    await sleep(500);
    eq(await flagOf(SA, clip.song.title), null, 'exact on the site, absent from the list: not 待处理');

    // QQ list has it exactly, the site does not: judged by the site → 待处理
    stub.songs.push({ id: '20', songType: 0, title: '__apkQQ独有', artist: SA });
    tags.supplySongs(user.id, 'qq:4343', { title: '测试歌单2', songs: stub.songs.map((x) => ({ ...x })), likedIds: [], dirId: 513 });
    const qqOnly = await tags.ingest({ session: platSession, rawText: '《__apkQQ独有》', singer: SA });
    ok(['liked', 'already_liked'].includes(qqOnly.outcome) || (qqOnly.outcome === 'pending' && qqOnly.autoRetry === true), `QQ: exact in the list is liked as before (${qqOnly.outcome})`);
    await sleep(400);
    ok(await flagOf(SA, '__apkQQ独有'), 'QQ: exact in the QQ list but not on the site → 待处理');
    // a 网站歌名 that does name a site song → not marked
    const gc2 = await gep.addSong(SA, '__apk游戏名丙');
    await gep.addAlias(gc2.id, clip.song.title);
    await tags.ingest({ session: platSession, rawText: '《__apk游戏名丙》', singer: SA });
    await sleep(400);
    eq(await flagOf(SA, '__apk游戏名丙'), null, 'QQ: 网站歌名 names a song on the site → not 待处理');

    // 已处理 / adding a 网站歌名 clear it; the counts follow
    const flaggedNow = await prisma.gepSingerSong.count({ where: { singer: SA, needsReviewAt: { not: null } } });
    let listed = (await gep.listSingers({ query: SA, reviewOnly: true })).singers.find((x) => x.singer === SA);
    eq(listed && listed.review, flaggedNow, `singer list counts 待处理 (${flaggedNow})`);
    const nearRow = (await gep.listSongs(SA)).songs.find((x) => x.title === '__apkQQ独有');
    ok(nearRow.needsReviewAt, 'songs list carries needsReviewAt');
    await gep.addAlias(nearRow.id, clip.song.title);
    eq(await flagOf(SA, '__apkQQ独有'), null, 'adding a 网站歌名 clears 待处理');
    const dcWas = Boolean(await flagOf(SA, '大城小爱 (Live)'));
    const dcRow = await gep.addSong(SA, '大城小爱 (Live)');
    await gep.addAlias(dcRow.id, '大城小爱');
    eq(await flagOf(SA, '大城小爱 (Live)'), null, 'and that one clears too');
    const noneRow = (await gep.listSongs(SA)).songs.find((x) => x.title === '__apk哪里都没有的歌');
    await gep.clearReview(noneRow.id);
    eq(await flagOf(SA, '__apk哪里都没有的歌'), null, '已处理 clears 待处理');
    const left = await prisma.gepSingerSong.count({ where: { singer: SA, needsReviewAt: { not: null } } });
    eq(left, flaggedNow - 2 - (dcWas ? 1 : 0), 'the cleared ones are off the list');

    // 方案 B: a near match is tried against the 网站歌名 too
    const twins = await tags.ingest({ session: platSession, rawText: '《__apk同名》', singer: SA });
    eq(twins.outcome, 'ambiguous', 'QQ: two songs with this exact name → 选一个 as before');
    await sleep(300);
    eq(Boolean(await flagOf(SA, '__apk同名')), !(await siteExact('__apk同名')), 'QQ: several exact in the list → judged by the site');
    const nearBefore = await tags.ingest({ session: platSession, rawText: '《__apk近似歌》', singer: SA });
    eq([nearBefore.outcome, nearBefore.candidates[0].kind], ['pending', 'bracket'], 'QQ: near match, no 网站歌名 yet → 待确认 as before');
    await sleep(300);
    ok(await flagOf(SA, '__apk近似歌'), 'near match: 待处理');
    const nearRow2 = (await gep.listSongs(SA)).songs.find((x) => x.title === '__apk近似歌');
    await gep.addAlias(nearRow2.id, '__apk近似歌 (Live)');
    // a fresh list so the same title is not a duplicate of the capture above
    tags.supplySongs(user.id, 'qq:4444', { title: '测试歌单3', songs: stub.songs.map((x) => ({ ...x })), likedIds: [], dirId: 514 });
    await tags.start({ userId: user.id, playlistRef: 'qq:4444', dirId: 514 });
    const nearAfter = await tags.ingest({ session: platSession, rawText: '《__apk近似歌》', singer: SA });
    ok(nearAfter.outcome === 'liked' || (nearAfter.outcome === 'pending' && nearAfter.autoRetry === true),
      `QQ: near match + 网站歌名 credited to the singer → auto-liked (${nearAfter.outcome})`);
    eq([nearAfter.candidates.length, nearAfter.candidates[0].externalId, nearAfter.candidates[0].auto], [1, '17', true], 'one candidate, the aliased song, auto');
    await sleep(300);
    ok(await flagOf(SA, '__apk近似歌'), 'QQ: its 网站歌名 names a QQ-only title, nothing on the site → 待处理 again');
    // A capture interrupted mid-match comes back 'unread' with its singer, and
    // the rematch still goes through the 网站歌名 (here: auto).
    const sid = platSession.id;
    await prisma.platformTagEvent.create({ data: { sessionId: sid, userId: user.id, platform: 'qq', playlistRef: 'qq:4545', rawText: '《__apk游戏名甲》', outcome: 'unread', candidates: [{ singer: SA }] } });
    // The rematch is for the run aimed at that list: aim there, then the list arrives.
    tags.supplySongs(user.id, 'qq:4545', { title: '测试歌单4', songs: stub.songs.map((x) => ({ ...x })), likedIds: [], dirId: 515 });
    await tags.start({ userId: user.id, playlistRef: 'qq:4545', dirId: 515 });
    tags.supplySongs(user.id, 'qq:4545', { title: '测试歌单4', songs: stub.songs.map((x) => ({ ...x })), likedIds: [], dirId: 515 });
    await sleep(1500);
    const rem = await prisma.platformTagEvent.findUnique({ where: { sessionId_playlistRef_rawText: { sessionId: sid, playlistRef: 'qq:4545', rawText: '《__apk游戏名甲》' } } });
    ok(rem && Array.isArray(rem.candidates) && rem.candidates[0] && rem.candidates[0].auto === true && rem.candidates[0].externalId === '15',
      `QQ: rematch after an interruption still uses the singer's 网站歌名 (${rem && rem.outcome})`);

    // uncredited near match with a 网站歌名: exactly as before
    // 《大城小爱 (Live)》 is a near match of 大城小爱 (王力宏), and got a 网站歌名
    // 「大城小爱」 above -- which finds that same uncredited song.
    const nearOther = await tags.ingest({ session: platSession, rawText: '《大城小爱 (Live)》', singer: SA });
    eq([nearOther.outcome, nearOther.candidates.map((c) => c.kind)], ['pending', ['bracket']],
      'QQ: near match + uncredited 网站歌名 → exactly the near match as before');
    ok(!nearOther.candidates.some((c) => c.auto), 'QQ: 网站歌名 found a song not credited to the singer → nothing auto');
    eq(nearOther.autoRetry, false, 'and not an auto-like');

    // pinyin order: singers and their songs
    for (const n of ['周', '阿', 'b']) await gep.addSong(`${SINGER_PREFIX}序${n}`, 'x');
    eq((await gep.listSingers({ query: `${SINGER_PREFIX}序` })).singers.map((x) => x.singer),
      [`${SINGER_PREFIX}序阿`, `${SINGER_PREFIX}序b`, `${SINGER_PREFIX}序周`], 'singers in pinyin order');
    for (const t of ['周杰', '阿桑', 'Bxyz']) await gep.addSong(`${SINGER_PREFIX}序周`, t);
    eq((await gep.listSongs(`${SINGER_PREFIX}序周`)).songs.map((x) => x.title), ['阿桑', 'Bxyz', 'x', '周杰'], 'songs in pinyin order');

    // 歌单: the same rule; the page's isPerfect() reads `auto`
    await captureService.setTarget({ userId: user.id, target: 'playlist', playlistId: playlist.id });
    const realSinger = String(clip.song.artist || '').split(/[/_、,，&]+/)[0].trim();
    const gc = await gep.addSong(realSinger, '__apk歌单游戏名');
    await gep.addAlias(gc.id, clip.song.title);
    const fresh2 = await prisma.captureSession.findUnique({ where: { id: session.id } });
    try {
      const pl = await captureService.ingestText({ session: fresh2, rawText: '《__apk歌单游戏名》', singer: realSinger });
      const inPl = (pl.candidates || []).filter((c) => c.inPlaylist);
      eq([pl.outcome, inPl.length, inPl[0] && inPl[0].kind, inPl[0] && inPl[0].auto], ['pending', 1, 'alias', true],
        '歌单: one credited song via 网站歌名 → pending, marked auto');
      const isPerfect = (e) => {
        if (e.outcome !== 'pending') return false;
        const cands = (e.candidates || []).filter((c) => c.inPlaylist);
        return cands.length === 1 && (cands[0].kind === 'exact' || cands[0].auto === true) && cands[0].clips.length === 1;
      };
      eq(isPerfect(pl), true, "the page's isPerfect() takes it");
      eq(isPerfect(viaAlias2), false, 'the uncredited one (earlier, singer not on the song) it does not');
      await sleep(300);
      eq(await flagOf(realSinger, '__apk歌单游戏名'), null, '歌单: found via 网站歌名: not 待处理');
      // 方案 B on the playlist page: a near title, then a 网站歌名
      const nearTitle = `${clip.song.title} (Live)`;
      const plNearBefore = await captureService.ingestText({ session: fresh2, rawText: `《${nearTitle}》`, singer: realSinger });
      const nearIn = (plNearBefore.candidates || []).filter((c) => c.inPlaylist);
      ok(nearIn.length >= 1 && !nearIn.some((c) => c.kind === 'exact') && !isPerfect(plNearBefore),
        `歌单: near title → not acted on (${plNearBefore.outcome}, ${nearIn.map((c) => c.kind).join(',')})`);
      await sleep(300);
      ok(await flagOf(realSinger, nearTitle), '歌单: near title: 待处理');
      const gn = (await gep.listSongs(realSinger)).songs.find((x) => x.title === nearTitle);
      await gep.addAlias(gn.id, clip.song.title);
      eq(await flagOf(realSinger, nearTitle), null, '网站歌名 added: cleared');
      const playlist2 = await prisma.playlist.create({ data: { name: `__apk_test_${Date.now()}_2`, userId: user.id } });
      created.playlists.push(playlist2.id);
      await prisma.playlistClip.create({ data: { playlistId: playlist2.id, clipId: clip.id, position: 0 } });
      await captureService.setTarget({ userId: user.id, target: 'playlist', playlistId: playlist2.id });
      const fresh3 = await prisma.captureSession.findUnique({ where: { id: session.id } });
      const plNearAfter = await captureService.ingestText({ session: fresh3, rawText: `《${nearTitle}》`, singer: realSinger });
      const afterIn = (plNearAfter.candidates || []).filter((c) => c.inPlaylist);
      eq([afterIn.length, afterIn[0] && afterIn[0].kind, afterIn[0] && afterIn[0].auto], [1, 'alias', true],
        '歌单: near title + credited 网站歌名 → one candidate, auto');
      eq(isPerfect(plNearAfter), true, "歌单: the page's isPerfect() takes it");
      const plExact = await captureService.ingestText({ session: fresh3, rawText: `《${clip.song.title}》`, singer: realSinger });
      const exIn = (plExact.candidates || []).filter((c) => c.inPlaylist);
      eq([plExact.outcome, exIn.length, exIn[0] && exIn[0].kind, exIn[0] && exIn[0].auto, isPerfect(plExact)],
        ['pending', 1, 'exact', undefined, true], '歌单: a perfect title match exactly as before (acted on, no auto marker)');
      ok(!(plExact.candidates || []).some((c) => 'credited' in c), 'stored candidates carry no `credited`');

      // The near match is a different song also in the playlist: the auto
      // match takes over and that one is not left beside it.
      const clip2 = await prisma.clip.findFirst({ where: { song: { id: { not: clip.song.id } } }, include: { song: { select: { id: true, title: true } } } });
      const playlist3 = await prisma.playlist.create({ data: { name: `__apk_test_${Date.now()}_3`, userId: user.id } });
      created.playlists.push(playlist3.id);
      await prisma.playlistClip.create({ data: { playlistId: playlist3.id, clipId: clip.id, position: 0 } });
      await prisma.playlistClip.create({ data: { playlistId: playlist3.id, clipId: clip2.id, position: 1 } });
      await prisma.playlistClip.create({ data: { playlistId: playlist2.id, clipId: clip2.id, position: 1 } });
      const otherNear = `${clip2.song.title} (Live)`;
      const beforeAlias = await captureService.ingestText({ session: fresh3, rawText: `《${otherNear}》`, singer: realSinger });
      ok((beforeAlias.candidates || []).some((c) => c.inPlaylist && String(c.songId) === String(clip2.song.id) && c.kind !== 'exact'),
        '歌单: before the 网站歌名, the other song is a near match in the playlist');
      const go = await gep.addSong(realSinger, otherNear);
      await gep.addAlias(go.id, clip.song.title);
      await captureService.setTarget({ userId: user.id, target: 'playlist', playlistId: playlist3.id });
      const fresh4 = await prisma.captureSession.findUnique({ where: { id: session.id } });
      const twoIn = await captureService.ingestText({ session: fresh4, rawText: `《${otherNear}》`, singer: realSinger });
      const twoInPl = (twoIn.candidates || []).filter((c) => c.inPlaylist);
      eq([twoInPl.length, twoInPl[0] && twoInPl[0].songId, twoInPl[0] && twoInPl[0].auto], [1, clip.song.id, true],
        '歌单: auto 网站歌名 match replaces a different near match in the playlist');
      eq(isPerfect(twoIn), true, "and the page's isPerfect() takes it");
      await prisma.gepSingerSong.deleteMany({ where: { singer: realSinger, title: otherNear } });
      await captureService.setTarget({ userId: user.id, target: 'playlist', playlistId: playlist.id });

      // An exact match elsewhere hides a near one in this playlist from the
      // matcher; it is still what a 网站歌名 would fix, so it is marked.
      const tmpSongs = [];
      try {
        const mk = async (title) => { const sg = await prisma.song.create({ data: { title, artist: 'apkTest临时', filePath: '__apk/none.mp3' } }); tmpSongs.push(sg.id); return sg; };
        await mk('__apkT标题');
        const nearSong = await mk('__apkT标题 (Live)');
        const nearClip = await prisma.clip.create({ data: { songId: nearSong.id, start: 0, length: 20 } });
        await prisma.playlistClip.create({ data: { playlistId: playlist.id, clipId: nearClip.id, position: 9 } });
        await mk('__apkU标题');
        const hidden = await captureService.ingestText({ session: fresh2, rawText: '《__apkT标题》', singer: 'apkTest歌手乙' });
        eq(hidden.outcome, 'not_in_playlist', '歌单: exact elsewhere, near here → outcome as before');
        const absentOnly = await captureService.ingestText({ session: fresh2, rawText: '《__apkU标题》', singer: 'apkTest歌手乙' });
        eq(absentOnly.outcome, 'not_in_playlist', '歌单: exact elsewhere, nothing here → as before');
        await sleep(500);
        ok(await flagOf('apkTest歌手乙', '__apkT标题'), '歌单: near match hidden by an exact one elsewhere: 待处理');
        eq(await flagOf('apkTest歌手乙', '__apkU标题'), null, '歌单: right title, song just not in this playlist: not 待处理');
      } finally {
        await prisma.playlistClip.deleteMany({ where: { clip: { songId: { in: tmpSongs } } } });
        await prisma.clip.deleteMany({ where: { songId: { in: tmpSongs } } });
        await prisma.song.deleteMany({ where: { id: { in: tmpSongs } } });
      }

      // a 网站歌名 that names nothing on the site → 待处理 all the same
      const wrong = await gep.addSong(realSinger, '__apk映射写错了');
      await gep.addAlias(wrong.id, '__apk网站上不存在的名字');
      await captureService.ingestText({ session: fresh2, rawText: '《__apk映射写错了》', singer: realSinger });
      await sleep(300);
      ok(await flagOf(realSinger, '__apk映射写错了'), '歌单: 网站歌名 naming nothing on the site → 待处理');

      // a 网站歌名 that finds a site song NOT in this playlist → not marked (it is right; the playlist just lacks it)
      const otherSiteSong = await prisma.song.findFirst({ where: { id: { not: clip.song.id }, title: { not: clip.song.title } }, select: { title: true } });
      const okAlias = await gep.addSong(realSinger, '__apk映射正确但不在歌单');
      await gep.addAlias(okAlias.id, otherSiteSong.title);
      await captureService.ingestText({ session: fresh2, rawText: '《__apk映射正确但不在歌单》', singer: realSinger });
      await sleep(300);
      eq(await flagOf(realSinger, '__apk映射正确但不在歌单'), null, '歌单: 网站歌名 finds a site song (not in this playlist) → not 待处理');

      // evenWithAlias marks over only the 网站歌名 it read
      const rc = await gep.addSong('apkTest歌手乙', '__apk竞争2');
      await gep.addAlias(rc.id, '__apk后来加的对的');
      gep.noteReview('apkTest歌手乙', '__apk竞争2', { evenWithAlias: true, seenAliases: ['__apk读到的错的'] });
      await sleep(300);
      eq(await flagOf('apkTest歌手乙', '__apk竞争2'), null, 'a 网站歌名 added after the read is not marked over');
      gep.noteReview('apkTest歌手乙', '__apk竞争2', { evenWithAlias: true, seenAliases: ['__apk后来加的对的'] });
      await sleep(300);
      ok(await flagOf('apkTest歌手乙', '__apk竞争2'), 'the 网站歌名 that were read (and found wrong) are marked over');

      // loose near match hidden by an exact one elsewhere: not marked (too often another song)
      const tmp2 = [];
      try {
        const mk2 = async (title) => { const sg = await prisma.song.create({ data: { title, artist: 'apkTest临时', filePath: '__apk/none.mp3' } }); tmp2.push(sg.id); return sg; };
        await mk2('__apkLove Is Everything');
        const looseSong = await mk2('__apkLove');
        const looseClip = await prisma.clip.create({ data: { songId: looseSong.id, start: 0, length: 20 } });
        await prisma.playlistClip.create({ data: { playlistId: playlist.id, clipId: looseClip.id, position: 10 } });
        const kinds = mt('《__apkLove Is Everything》', [{ id: 'x', title: '__apkLove', artist: '' }]).candidates.map((c) => c.kind);
        eq(kinds, ['loose'], '(the hidden one is a loose match)');
        await captureService.ingestText({ session: fresh2, rawText: '《__apkLove Is Everything》', singer: 'apkTest歌手乙' });
        await sleep(500);
        eq(await flagOf('apkTest歌手乙', '__apkLove Is Everything'), null, '歌单: only a loose near match in the playlist → not 待处理');
      } finally {
        await prisma.playlistClip.deleteMany({ where: { clip: { songId: { in: tmp2 } } } });
        await prisma.clip.deleteMany({ where: { songId: { in: tmp2 } } });
        await prisma.song.deleteMany({ where: { id: { in: tmp2 } } });
      }

      // A 网站歌名 added while a capture is in flight is not marked over
      const raceRow = await gep.addSong('apkTest歌手乙', '__apk竞争');
      await gep.addAlias(raceRow.id, '__apk随便');
      gep.noteReview('apkTest歌手乙', '__apk竞争');
      await sleep(300);
      eq(await flagOf('apkTest歌手乙', '__apk竞争'), null, 'a title with a 网站歌名 is never marked');

      const plNone = await captureService.ingestText({ session: fresh2, rawText: '《__apk歌单里没有的歌》', singer: realSinger });
      eq(plNone.outcome, 'no_match', '歌单: nothing → no_match');
      await sleep(300);
      ok(await flagOf(realSinger, '__apk歌单里没有的歌'), '歌单: no match: 待处理');
    } finally {
      await prisma.gepSingerSong.deleteMany({ where: { singer: realSinger, OR: [{ title: { startsWith: '__apk' } }, { title: `${clip.song.title} (Live)` }] } });
    }
    passed += 1;

    console.log(`apk-capture-test: all ${passed} checks passed`);
  } finally {
    await prisma.gepSingerSong.deleteMany({ where: { singer: { startsWith: SINGER_PREFIX } } });
    await prisma.gepSingerSong.deleteMany({ where: { singer: { startsWith: 'apkTest' } } });
    if (savedSetting) {
      await prisma.setting.upsert({ where: { key: savedSetting.key }, create: { key: savedSetting.key, value: savedSetting.value }, update: { value: savedSetting.value } });
    } else {
      await prisma.setting.deleteMany({ where: { key: settingsService.APK_LIKES_KEY } });
    }
    for (const id of created.sessions) {
      await prisma.captureSession.deleteMany({ where: { id } });
    }
    for (const id of created.playlists) {
      await prisma.playlistClip.deleteMany({ where: { playlistId: id } });
      await prisma.like.deleteMany({ where: { playlistId: id } }).catch(() => {});
      await prisma.playlist.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
