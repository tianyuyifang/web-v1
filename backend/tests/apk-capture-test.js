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
    passed += 1;

    console.log(`apk-capture-test: all ${passed} checks passed`);
  } finally {
    await prisma.gepSingerSong.deleteMany({ where: { singer: { startsWith: SINGER_PREFIX } } });
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
