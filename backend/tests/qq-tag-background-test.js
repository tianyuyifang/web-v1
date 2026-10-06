/**
 * QQ打标 with the page in the background (2026-10-05).
 *
 *   - A page says when it goes to the background (presence). Its likes then go
 *     to the phone first, and to such a page only last: a phone browser has
 *     frozen it, a desktop one may still manage.
 *   - An exact match nobody could like is marked autoRetry, for the page to
 *     like when it is next in front; nothing else is.
 *   - 取消全部点赞 is reported in one go (noteManyUnliked).
 *   - Through all of it the server never calls QQ.
 *
 * The platform layer is stubbed in the require cache; every call is recorded.
 * Run: node tests/qq-tag-background-test.js
 */
require('dotenv').config();
const assert = require('assert');
const { EventEmitter } = require('events');

const likePath = require.resolve('../src/services/platformLikeService');
const calls = [];
const real = require(likePath);
require.cache[likePath].exports = {
  ...real,
  async like(userId, platform, args) { calls.push(['like', platform, String(args.id)]); return { ok: true, alreadyLiked: false }; },
  async unlike(userId, platform, args) { calls.push(['unlike', platform, String(args.id)]); return { ok: true }; },
  async likedMap(userId, platform) { calls.push(['likedMap', platform]); return new Map(); },
  async getPlaylistSongs(userId, ref) { calls.push(['songs', ref]); throw new Error('not in this test'); },
  async listPlaylists(userId, platform) { calls.push(['list', platform]); return []; },
};

const access = require('../src/services/musicCredentialAccess');
const realFresh = access.getFreshCredential;
access.getFreshCredential = async (userId, platform) => (platform === 'qq'
  ? { uin: '10001', musicKey: 'W_Xfake', cookie: 'uin=10001; qm_keyst=W_Xfake' }
  : realFresh(userId, platform));

const prisma = require('../src/db/client');
const tags = require('../src/services/platformTagService');
const apkLikes = require('../src/services/apkLikeService');
const apkChannel = require('../src/services/apkChannel');
const captureService = require('../src/services/captureService');
const settingsService = require('../src/services/settingsService');

let pass = 0;
function ok(cond, what) {
  assert.ok(cond, what);
  pass += 1;
  console.log('  PASS', what);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const song = (id, title) => ({ id, songType: 0, mid: null, title, artist: 'a', durationSec: null, vipOnly: false });

/** A QQ打标 page's executor stream; `answer` false = frozen (never claims). */
function fakePage(userId, clientId, { answer = true } = {}) {
  const res = new EventEmitter();
  apkLikes.attachPageExecutor(userId, res, clientId);
  const seen = [];
  const mode = { answer };
  const timer = setInterval(async () => {
    for (const cmd of apkLikes._pending.values()) {
      if (cmd.executor !== 'page' || cmd.userId !== userId || cmd.state !== 'sent' || seen.includes(cmd.id)) continue;
      seen.push(cmd.id);
      if (!mode.answer) continue;
      const job = await apkLikes.claimPage(userId, cmd.id);
      if (job) apkLikes.resultPage(userId, cmd.id, { ok: true, calls: 2 });
    }
  }, 20);
  return { seen, mode, close: () => { clearInterval(timer); res.emit('close'); } };
}

/** The phone's push stream (apkChannel), claiming and reporting like APK v28. */
function fakePhoneStream() {
  const r = new EventEmitter();
  r.frames = [];
  r.writeHead = () => {};
  r.write = (s) => { r.frames.push(s); r.emit('frame', s); return true; };
  r.end = () => r.emit('close');
  return r;
}

(async () => {
  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  assert.ok(user, 'need an ADMIN user');
  const savedApk = await prisma.setting.findUnique({ where: { key: settingsService.APK_LIKES_KEY } });
  await settingsService.setApkLikes({ enabled: true, adminsOnly: false, auto: true, approve: true, manual: true });
  // Retry timers off for the single-pass steps; section 10 turns them on, short.
  tags._setAutoRetry({ delays: [] });
  const { session } = await captureService.connect({ userId: user.id, label: 'qq-tag-background-test' });
  const fresh = () => prisma.captureSession.findUnique({ where: { id: session.id } });
  const pages = [];
  let phoneStream = null;
  try {
    const titles = ['一', '二', '三', '四', '五', '六', '七', '八'].map((t) => `测试${t}`);
    const listSongs = titles.map((t, i) => song(String(9100 + i), t));
    listSongs.push(song('9190', '括号歌 (Live)'));
    tags.supplySongs(user.id, 'qq:9100', { title: 'bg', songs: listSongs.map((x) => ({ ...x })), likedIds: [], dirId: 512 });
    const started = await tags.start({ userId: user.id, playlistRef: 'qq:9100', dirId: 512 });
    const platSession = started.session;

    // The phone: claims and reports when `phone.answer`.
    phoneStream = fakePhoneStream();
    ok(await apkChannel.attach(platSession, phoneStream, { version: 28, caps: [apkLikes.CAP] }), 'phone stream attached');
    const phone = { answer: true, seen: [] };
    phoneStream.on('frame', (f) => {
      if (!f.startsWith('event: cmd\n')) return;
      const { cmdId } = JSON.parse(f.split('\ndata: ')[1]);
      phone.seen.push(cmdId);
      if (!phone.answer) return;
      (async () => {
        const job = await apkLikes.claim(platSession, cmdId);
        if (job) apkLikes.result(platSession, cmdId, { ok: true, calls: 2 });
      })();
    });

    // 1. A page in front with the phone there too: the page takes it.
    const page = fakePage(user.id, 'pageA');
    pages.push(page);
    let r = await tags.ingest({ session: await fresh(), rawText: titles[0] });
    ok(r.outcome === 'liked' && page.seen.length === 1 && phone.seen.length === 0, 'in front: the page takes it, the phone is not asked');

    // 2. The page goes to the background: the phone first, the page not asked.
    ok(apkLikes.setPageHidden(user.id, 'pageA', true) === true, 'presence finds the page by its stream id');
    ok(apkLikes.setPageHidden(user.id, 'nobody', true) === false, 'an unknown stream id changes nothing');
    ok(apkLikes.pageAvailable(user.id, { hidden: false }) === false && apkLikes.pageAvailable(user.id, { hidden: true }) === true, 'counted as a page in the background');
    r = await tags.ingest({ session: await fresh(), rawText: titles[1] });
    ok(r.outcome === 'liked' && phone.seen.length === 1 && page.seen.length === 1, 'in the background: the phone takes it, the page is not offered');

    // 3. Background page, phone not answering: the page is offered last, and takes it.
    phone.answer = false;
    let t0 = Date.now();
    r = await tags.ingest({ session: await fresh(), rawText: titles[2] });
    ok(r.outcome === 'liked' && phone.seen.length === 2 && page.seen.length === 2, 'phone silent: the background page is offered after it, and takes it');
    ok(Date.now() - t0 >= apkLikes.CLAIM_MS, `the phone had its full claim window first (${Date.now() - t0} ms)`);

    // 4. Background page frozen, phone silent: 待确认, marked for catch-up.
    page.mode.answer = false;
    t0 = Date.now();
    r = await tags.ingest({ session: await fresh(), rawText: titles[3] });
    const waited = Date.now() - t0;
    ok(r.outcome === 'pending' && r.autoRetry === true, 'nobody took it: 待确认, autoRetry');
    ok(r.error.startsWith(apkLikes.NO_EXECUTOR_PREFIX), `error starts with the shared prefix (${r.error})`);
    ok(waited < 2 * apkLikes.CLAIM_MS + 1500, `phone then page, each offered once (${waited} ms, under the client's 20 s)`);
    const missedId = r.eventId;

    // 5. Coming back to the front: the stream re-attaches as in front (and the
    //    page's presence says so); the like goes to the page first again.
    apkLikes.setPageHidden(user.id, 'pageA', false);
    page.mode.answer = true;
    phone.answer = true;
    const phoneBefore = phone.seen.length;
    r = await tags.ingest({ session: await fresh(), rawText: titles[4] });
    ok(r.outcome === 'liked' && phone.seen.length === phoneBefore, 'back in front: the page again, the phone not asked');
    const reopened = fakePage(user.id, 'pageB');
    pages.push(reopened);
    ok(apkLikes.pageAvailable(user.id, { hidden: false }), 'a newly opened stream counts as in front');
    reopened.close();

    // 6. The page catches up: the same approve its 点赞 button makes.
    r = await tags.approve({ userId: user.id, eventId: missedId, browserResult: { ok: true, alreadyLiked: false } });
    ok(r.outcome === 'liked' && r.autoRetry === false, 'caught up: liked, no longer autoRetry');

    // 7. Never marked: a match that needs a human, a dead login. A failure for now (2001) is.
    page.close();
    phone.answer = false;
    r = await tags.ingest({ session: await fresh(), rawText: '括号歌' });
    ok(r.outcome === 'pending' && r.autoRetry === false, 'not exact (bracket): waits for the user, not caught up automatically');
    const refusing = fakePage(user.id, 'pageC');
    pages.push(refusing);
    refusing.close();
    const refusingPage = (clientId, code) => {
      const res = new EventEmitter();
      apkLikes.attachPageExecutor(user.id, res, clientId);
      const timer = setInterval(async () => {
        for (const cmd of apkLikes._pending.values()) {
          if (cmd.executor !== 'page' || cmd.state !== 'sent') continue;
          if (await apkLikes.claimPage(user.id, cmd.id)) apkLikes.resultPage(user.id, cmd.id, { ok: false, code, calls: 1 });
        }
      }, 20);
      return () => { clearInterval(timer); res.emit('close'); };
    };
    let closeRefuser = refusingPage('pageD', 1000);
    r = await tags.ingest({ session: await fresh(), rawText: titles[5] });
    closeRefuser();
    ok(r.outcome === 'failed' && r.autoRetry === false && /重新扫码/.test(r.error), 'dead login (1000): failed, not retried, says rescan');
    closeRefuser = refusingPage('pageE', 2001);
    r = await tags.ingest({ session: await fresh(), rawText: titles[7] });
    closeRefuser();
    ok(r.outcome === 'pending' && r.autoRetry === true, "QQ's 2001: waits, marked to be tried again");
    const feed = await tags.getFeed({ userId: user.id, sessionId: session.id });
    ok(feed.events.every((e) => typeof e.autoRetry === 'boolean'), 'the feed carries autoRetry on every row');

    // 8. No page at all, phone silent: still marked (the page catches up when opened).
    r = await tags.ingest({ session: await fresh(), rawText: titles[6] });
    ok(r.outcome === 'pending' && r.autoRetry === true && /都不在线|没有完成/.test(r.error), 'no page, no phone answer: autoRetry');

    // 9. 取消全部点赞: one report patches every cached list in one pass.
    tags.supplySongs(user.id, 'qq:9200', { title: 'run', songs: [song('9201', 'a1'), song('9202', 'a2'), song('9203', 'a3')], likedIds: ['9201', '9202', '9203'], dirId: 512 });
    tags.supplySongs(user.id, 'qq:9299', { title: '我喜欢', songs: [song('9201', 'a1'), song('9202', 'a2'), song('9203', 'a3'), song('9204', 'a4')], likedIds: ['9201', '9202', '9203', '9204'], dirId: 201, isLikes: true });
    tags.noteManyUnliked(user.id, ['9201', '9202']);
    const run = tags.cachedPlaylistWithLiked(user.id, 'qq:9200');
    const likedOf = (id) => run.songs.find((s) => s.id === id).alreadyLiked;
    ok(likedOf('9201') === false && likedOf('9202') === false && likedOf('9203') === true, 'hearts turned off for exactly the unliked songs');
    const fav = tags.cachedPlaylistWithLiked(user.id, 'qq:9299');
    ok(fav.songs.map((s) => s.id).join(',') === '9203,9204', '我喜欢 lost exactly those rows, in place');
    const big = Array.from({ length: 5000 }, (_, i) => String(1000000 + i));
    tags.supplySongs(user.id, 'qq:9300', { title: 'big', songs: big.map((id) => song(id, `b${id}`)), likedIds: big, dirId: 512 });
    t0 = Date.now();
    tags.noteManyUnliked(user.id, big);
    const bigMs = Date.now() - t0;
    ok(bigMs < 1000, `5000 songs reported in one pass (${bigMs} ms)`);
    ok(tags.cachedPlaylistWithLiked(user.id, 'qq:9300').songs.every((s) => s.alreadyLiked === false), 'all 5000 shown unliked');

    // 10. Tried again on its own: timers after a miss, and at once when a page
    //     is there again -- through the same page/phone, never the server.
    tags._setAutoRetry({ delays: [300, 600, 900], max: 5 });
    const extra = ['重试一', '重试二', '重试三', '重试四', '重试五'].map((t, i) => song(String(9300 + i), t));
    tags.supplySongs(user.id, 'qq:9100', { title: 'bg', songs: [...listSongs, ...extra].map((x) => ({ ...x })), likedIds: [], dirId: 512 });
    /** A page whose answer can be changed: ok, or a failure code. Counts writes per song. */
    const flexPage = (clientId) => {
      const res = new EventEmitter();
      apkLikes.attachPageExecutor(user.id, res, clientId);
      const m = { fail: null, writes: {} };
      const seenCmd = new Set();
      const timer = setInterval(async () => {
        for (const cmd of apkLikes._pending.values()) {
          if (cmd.executor !== 'page' || cmd.userId !== user.id || cmd.state !== 'sent' || seenCmd.has(cmd.id)) continue;
          seenCmd.add(cmd.id);
          const job = await apkLikes.claimPage(user.id, cmd.id);
          if (!job) continue;
          m.writes[job.id] = (m.writes[job.id] || 0) + 1;
          apkLikes.resultPage(user.id, cmd.id, m.fail ? { ok: false, code: m.fail, calls: 1 } : { ok: true, calls: 2 });
        }
      }, 20);
      m.close = () => { clearInterval(timer); res.emit('close'); };
      return m;
    };
    const waitFor = async (id, want, ms) => {
      let row = null;
      for (let i = 0; i < ms / 100; i += 1) {
        row = await prisma.platformTagEvent.findUnique({ where: { id } });
        if (row && want(row)) return row;
        await sleep(100);
      }
      return row;
    };

    // 10a. One timeout on the page, phone silent: waits; the timer tries again and it is liked.
    phone.answer = false;
    const fp = flexPage('pageR');
    fp.fail = 'timeout';
    r = await tags.ingest({ session: await fresh(), rawText: '重试一' });
    ok(r.outcome === 'pending' && r.autoRetry === true, `timeout on the page: waits (${r.error})`);
    fp.fail = null;
    let row = await waitFor(r.eventId, (x) => x.outcome === 'liked', 8000);
    ok(row.outcome === 'liked' && fp.writes['9300'] === 2, `tried again on its own and liked (writes ${fp.writes['9300']})`);

    // 10b. Failing every time: after the cap it shows as failed, with why.
    tags._setAutoRetry({ delays: [100, 100, 100], max: 2 });
    fp.fail = 'timeout';
    r = await tags.ingest({ session: await fresh(), rawText: '重试二' });
    row = await waitFor(r.eventId, (x) => x.outcome === 'failed', 20000);
    ok(row.outcome === 'failed' && /自动重试 2 次/.test(row.error) && fp.writes['9301'] === 3, `gives up after the cap: failed, says so (writes ${fp.writes['9301']}: ${row.error})`);
    fp.fail = null;
    fp.close();
    tags._setAutoRetry({ delays: [300, 600, 900], max: 5 });

    // 10c. Nobody there (page closed, phone gone): waits without trying, then
    //      the page opening tries at once (the route's retryPendingFor).
    phoneStream.emit('close');
    await sleep(100);
    r = await tags.ingest({ session: await fresh(), rawText: '重试三' });
    ok(r.outcome === 'pending' && r.autoRetry === true && /都不在线/.test(r.error), 'nobody there: waits in 待确认');
    await sleep(1500);
    row = await prisma.platformTagEvent.findUnique({ where: { id: r.eventId } });
    ok(row.outcome === 'pending', 'and nothing is tried while nobody is there');
    const fp2 = flexPage('pageS');
    await tags.retryPendingFor(user.id);
    row = await prisma.platformTagEvent.findUnique({ where: { id: r.eventId } });
    ok(row.outcome === 'liked' && fp2.writes['9302'] === 1, 'page opened: tried at once and liked');

    // 10d. Every trigger at once (timer, page back, page opening): one like, not two.
    fp2.close();
    r = await tags.ingest({ session: await fresh(), rawText: '重试四' });
    const fp3 = flexPage('pageT');
    await Promise.all([tags.retryPendingFor(user.id), tags.retryPendingFor(user.id), tags.retryPendingFor(user.id)]);
    row = await waitFor(r.eventId, (x) => x.outcome === 'liked', 3000);
    await sleep(1500); // any timer still due fires and must find it done
    ok(row.outcome === 'liked' && fp3.writes['9303'] === 1, `three triggers together: liked once (writes ${fp3.writes['9303']})`);

    // 10e. Liked by hand (点赞) meanwhile: the retry leaves it alone.
    fp3.close();
    r = await tags.ingest({ session: await fresh(), rawText: '重试五' });
    await tags.approve({ userId: user.id, eventId: r.eventId, browserResult: { ok: true, alreadyLiked: false } });
    const fp4 = flexPage('pageU');
    await tags.retryPendingFor(user.id);
    await sleep(1200);
    ok(!fp4.writes['9304'], 'liked by hand first: not offered again');
    fp4.close();

    // 10f. A page in the background only (a desktop one, minimised), no phone app:
    //      timers still offer to it, and it likes it.
    tags._setAutoRetry({ delays: [200, 200, 200], max: 2 });
    const extra2 = ['后台一', '冻结一', '停止一'].map((t, i) => song(String(9400 + i), t));
    tags.supplySongs(user.id, 'qq:9100', { title: 'bg', songs: [...listSongs, ...extra, ...extra2].map((x) => ({ ...x })), likedIds: [], dirId: 512 });
    const hiddenPg = flexPage('pageV');
    apkLikes.setPageHidden(user.id, 'pageV', true);
    hiddenPg.fail = 'timeout';
    r = await tags.ingest({ session: await fresh(), rawText: '后台一' });
    ok(r.outcome === 'pending', 'background page failed once: waits');
    hiddenPg.fail = null;
    row = await waitFor(r.eventId, (x) => x.outcome === 'liked', 4000);
    ok(row.outcome === 'liked', 'a timer offered it to the background page, which liked it');
    // Reports arriving the wrong way round: the later one (by the page's count) wins.
    apkLikes.setPageHidden(user.id, 'pageV', true, 10);
    apkLikes.setPageHidden(user.id, 'pageV', false, 9);
    ok(apkLikes.pageAvailable(user.id, { hidden: true }) && !apkLikes.pageAvailable(user.id, { hidden: false }), 'an overtaken presence report is ignored');
    hiddenPg.close();

    // 10g. A page in front that never takes it (frozen mid-way): tries nobody took do
    //      not count -- not shown as failed after two of them.
    const frozenPg = fakePage(user.id, 'pageW', { answer: false });
    pages.push(frozenPg);
    r = await tags.ingest({ session: await fresh(), rawText: '冻结一' });
    await sleep(2 * apkLikes.CLAIM_MS + 1500);
    row = await prisma.platformTagEvent.findUnique({ where: { id: r.eventId } });
    ok(frozenPg.seen.length >= 3 && ['pending', 'matching'].includes(row.outcome), `unclaimed tries are not counted (${frozenPg.seen.length} offers, still ${row.outcome})`);
    frozenPg.close();
    await sleep(apkLikes.CLAIM_MS + 500);

    // 10h. 忽略 while it is being tried: refused, and the try never undoes it.
    await prisma.platformTagEvent.update({ where: { id: r.eventId }, data: { outcome: 'matching' } });
    let ignoreErr = null;
    try { await tags.ignore({ userId: user.id, eventId: r.eventId }); } catch (e) { ignoreErr = e; }
    ok(ignoreErr && ignoreErr.statusCode === 409 && /正在自动点赞/.test(ignoreErr.message), '忽略 during a try: refused, says why');
    let approveErr = null;
    try { await tags.approve({ userId: user.id, eventId: r.eventId, browserResult: { ok: true } }); } catch (e) { approveErr = e; }
    ok(approveErr && /正在自动点赞/.test(approveErr.message), '点赞 during a try: says it is being liked, not "已经处理过了"');
    await prisma.platformTagEvent.update({ where: { id: r.eventId }, data: { outcome: 'ignored' } });

    // 10i. A run stopped (or moved to another list): its rows are left to the user.
    r = await tags.ingest({ session: await fresh(), rawText: '停止一' });
    ok(r.outcome === 'pending' && r.autoRetry === true, 'missed (nobody there)');
    await tags.stop({ userId: user.id });
    const afterStop = flexPage('pageX');
    await tags.retryPendingFor(user.id);
    await sleep(1000);
    row = await prisma.platformTagEvent.findUnique({ where: { id: r.eventId } });
    ok(row.outcome === 'pending' && !afterStop.writes['9402'], 'run stopped: not tried again on its own');
    const stoppedFeed = (await tags.getFeed({ userId: user.id, sessionId: session.id })).events.find((e) => e.eventId === r.eventId);
    ok(stoppedFeed.autoRetry === false && /打标已停止/.test(stoppedFeed.error), `and it says so, no longer 待补点 (${stoppedFeed.error})`);
    afterStop.close();

    // 10j. A row written before this change (its message "没能点赞：打标网页…"): left to the user.
    const legacy = await prisma.platformTagEvent.create({
      data: {
        sessionId: session.id, userId: user.id, platform: 'qq', playlistRef: 'qq:9100', rawText: '旧行',
        outcome: 'pending', error: '没能点赞：打标网页/手机没有及时完成（网站不会代点），请在网页上确认',
        candidates: [{ externalId: '9100', songType: 0, title: '旧行', artist: 'a', kind: 'exact', note: null, alreadyLiked: null }],
      },
    });
    const legacyFeed = (await tags.getFeed({ userId: user.id, sessionId: session.id })).events.find((e) => e.eventId === legacy.id);
    ok(legacyFeed && legacyFeed.autoRetry === false, 'a row from before: not marked for automatic retry');

    // 10k. 取消全部点赞 is one replay entry: it does not push a real recent like out.
    tags.noteLiked(user.id, '9501');
    tags.noteManyUnliked(user.id, Array.from({ length: 400 }, (_, i) => String(2000000 + i)));
    // A read that was in flight during both: it still shows 9501 unliked.
    tags.supplySongs(user.id, 'qq:9500', { title: 'stale', songs: [song('9501', 'x1'), song('2000001', 'x2')], likedIds: ['2000001'], dirId: 512, readMs: 60000 });
    const staleView = tags.cachedPlaylistWithLiked(user.id, 'qq:9500');
    const likedIn = (id) => staleView.songs.find((s2) => s2.id === id).alreadyLiked;
    ok(likedIn('9501') === true && likedIn('2000001') === false, 'replay keeps the real like and applies the batch unlike');
    tags.dropSongs(user.id, 'qq:9500');

    // 10k2. QQ said 2001 ("too often"): the next try waits longer.
    await tags.start({ userId: user.id, playlistRef: 'qq:9100', dirId: 512 });
    tags._setAutoRetry({ delays: [200, 200, 200], max: 5, tooOften: 2000 });
    const extra3 = ['频繁一', '凭证一'].map((t, i) => song(String(9700 + i), t));
    tags.supplySongs(user.id, 'qq:9100', { title: 'bg', songs: [...listSongs, ...extra, ...extra2, ...extra3].map((x) => ({ ...x })), likedIds: [], dirId: 512 });
    const fp6 = flexPage('pageZ');
    fp6.fail = 2001;
    r = await tags.ingest({ session: await fresh(), rawText: '频繁一' });
    fp6.fail = null;
    await sleep(1000);
    const early = fp6.writes['9700'];
    row = await waitFor(r.eventId, (x) => x.outcome === 'liked', 6000);
    ok(early === 1 && row.outcome === 'liked' && fp6.writes['9700'] === 2, `2001: not retried within a second (writes ${early}), liked later`);
    // A credential read that broke is "not now", not "no QQ account".
    const savedFresh = access.getFreshCredential;
    access.getFreshCredential = async () => { throw new Error('db hiccup'); };
    r = await tags.ingest({ session: await fresh(), rawText: '凭证一' });
    access.getFreshCredential = savedFresh;
    ok(r.outcome === 'pending' && r.autoRetry === true, `a broken credential read: waits, retried (${r.outcome})`);
    row = await waitFor(r.eventId, (x) => x.outcome === 'liked', 4000);
    ok(row.outcome === 'liked', 'and is liked once the read works');
    fp6.close();
    tags._setAutoRetry({ delays: [200, 200, 200], max: 5, tooOften: 30000 });

    // 10l. Left 'matching' by a restart: after a minute, 点赞 / 忽略 / a retry may take it.
    await tags.start({ userId: user.id, playlistRef: 'qq:9100', dirId: 512 });
    const prefix = apkLikes.NO_EXECUTOR_PREFIX;
    const exactCand = (id, title) => [{ externalId: id, songType: 0, title, artist: 'a', kind: 'exact', note: null, alreadyLiked: null }];
    const mkRow = (rawText, extraData) => prisma.platformTagEvent.create({
      data: { sessionId: session.id, userId: user.id, platform: 'qq', playlistRef: 'qq:9100', rawText, ...extraData },
    });
    const age = (id, sec) => prisma.$executeRaw`UPDATE platform_tag_events SET updated_at = now() - make_interval(secs => ${sec}) WHERE id = ${id}::uuid`;
    const s1 = await mkRow('卡住一', { outcome: 'matching', error: `${prefix}/手机这次没有完成`, candidates: exactCand('9601', '卡住一') });
    await age(s1.id, 120);
    r = await tags.approve({ userId: user.id, eventId: s1.id, browserResult: { ok: true, alreadyLiked: false } });
    ok(r.outcome === 'liked', 'stale matching: 点赞 works');
    const s2 = await mkRow('卡住二', { outcome: 'matching', error: `${prefix}/手机这次没有完成`, candidates: exactCand('9602', '卡住二') });
    await age(s2.id, 120);
    r = await tags.ignore({ userId: user.id, eventId: s2.id });
    ok(r.outcome === 'ignored', 'stale matching: 忽略 works');
    const s3 = await mkRow('卡住三', { outcome: 'matching', error: `${prefix}/手机这次没有完成`, candidates: exactCand('9603', '卡住三') });
    await age(s3.id, 120);
    const fp5 = flexPage('pageY');
    await tags.retryPendingFor(user.id);
    row = await prisma.platformTagEvent.findUnique({ where: { id: s3.id } });
    ok(row.outcome === 'liked' && fp5.writes['9603'] === 1, 'stale matching missed auto-like: retried on the page coming back');
    fp5.close();
    const s4 = await mkRow('卡住四', { outcome: 'matching', error: `${prefix}/手机这次没有完成`, candidates: exactCand('9604', '卡住四') });
    let freshErr = null;
    try { await tags.ignore({ userId: user.id, eventId: s4.id }); } catch (e) { freshErr = e; }
    ok(freshErr && freshErr.statusCode === 409, 'a fresh matching row (a try in flight) is still protected');

    // 10m. Startup: rows left 'matching' by the old process are put back.
    const startedAt = new Date();
    const m1 = await mkRow('重启一', { outcome: 'matching', error: `${prefix}/手机这次没有完成`, candidates: exactCand('9605', '重启一') });
    const m2 = await mkRow('重启二', { outcome: 'matching' }); // a capture not yet matched
    await age(m1.id, 5);
    await age(m2.id, 5);
    const m3 = await mkRow('重启三', { outcome: 'matching' }); // touched after the start: in flight now
    const recovered = await tags.recoverAfterRestart(startedAt);
    const [r1, r2, r3] = await Promise.all([m1, m2, m3].map((x) => prisma.platformTagEvent.findUnique({ where: { id: x.id } })));
    ok(recovered >= 2 && r1.outcome === 'pending' && r2.outcome === 'unread' && r3.outcome === 'matching',
      `restart recovery: missed like -> 待确认, unmatched -> unread, in-flight untouched (${r1.outcome}/${r2.outcome}/${r3.outcome})`);
    await prisma.platformTagEvent.deleteMany({ where: { id: { in: [m1.id, m2.id, m3.id, s4.id] } } });
    await tags.stop({ userId: user.id });

    // 12. A new run (停止 then 开始 on the same list) matches its titles afresh,
    //     as the playlist page does; within one run a title is still matched once.
    tags._setAutoRetry({ delays: [] });
    const rerunSongs = ['再来一', '再来二'].map((t, i) => song(String(9800 + i), t));
    tags.supplySongs(user.id, 'qq:9100', { title: 'bg', songs: [...listSongs, ...extra, ...extra2, ...extra3, ...rerunSongs].map((x) => ({ ...x })), likedIds: [], dirId: 512 });
    await tags.start({ userId: user.id, playlistRef: 'qq:9100', dirId: 512 });
    const fp7 = flexPage('pageR2');
    r = await tags.ingest({ session: await fresh(), rawText: '再来一' });
    ok(r.outcome === 'liked' && fp7.writes['9800'] === 1, 'run 1: liked');
    r = await tags.ingest({ session: await fresh(), rawText: '再来一' });
    ok(r.outcome === 'duplicate', 'run 1, the same title again: duplicate');
    // 取消全部点赞, then a new run on the same list.
    tags.noteManyUnliked(user.id, ['9800']);
    await tags.stop({ userId: user.id });
    const startedRun2 = await tags.start({ userId: user.id, playlistRef: 'qq:9100', dirId: 512 });
    ok(startedRun2.session.platformRunStartedAt instanceof Date, 'start records when the run began');
    r = await tags.ingest({ session: await fresh(), rawText: '再来一' });
    ok(r.outcome === 'liked' && fp7.writes['9800'] === 2, `run 2: the earlier run's title is matched and liked again (${r.outcome}, writes ${fp7.writes['9800']})`);
    const left = await prisma.platformTagEvent.count({ where: { sessionId: session.id, playlistRef: 'qq:9100', rawText: '再来一' } });
    ok(left === 1, 'one row for it, this run\'s');
    r = await tags.ingest({ session: await fresh(), rawText: '再来一' });
    ok(r.outcome === 'duplicate', 'run 2, the same title again: duplicate');
    // A row of the earlier run still being liked (a fresh 'matching') is not taken away.
    const inFlightOld = await prisma.platformTagEvent.create({
      data: { sessionId: session.id, userId: user.id, platform: 'qq', playlistRef: 'qq:9100', rawText: '再来二', outcome: 'matching',
        createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    r = await tags.ingest({ session: await fresh(), rawText: '再来二' });
    ok(r.outcome === 'duplicate' && (await prisma.platformTagEvent.findUnique({ where: { id: inFlightOld.id } })) !== null,
      'an earlier run\'s row with a like in flight stays (duplicate for now)');
    const feedNow = await tags.getFeed({ userId: user.id, sessionId: session.id });
    ok(feedNow.runStartedAt && new Date(feedNow.runStartedAt).getTime() === new Date(startedRun2.session.platformRunStartedAt).getTime(),
      'the feed says when the current run began (for another browser)');
    fp7.close();
    await tags.stop({ userId: user.id });

    // 11. The server never called QQ.
    ok(calls.filter((c) => c[1] === 'qq' || String(c[1] || '').startsWith('qq')).length === 0, `no QQ call from the server (${JSON.stringify(calls)})`);

    console.log(`\nqq-tag-background-test: ${pass} passed`);
  } finally {
    pages.forEach((p) => p.close());
    if (phoneStream) phoneStream.emit('close');
    await prisma.captureSession.delete({ where: { id: session.id } }).catch(() => {});
    for (const ref of ['qq:9100', 'qq:9200', 'qq:9299', 'qq:9300']) tags.dropSongs(user.id, ref);
    if (savedApk) await prisma.setting.update({ where: { key: savedApk.key }, data: { value: savedApk.value } });
    else await prisma.setting.deleteMany({ where: { key: settingsService.APK_LIKES_KEY } });
    await prisma.$disconnect();
  }
})().catch(async (err) => {
  console.error('FAIL', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
