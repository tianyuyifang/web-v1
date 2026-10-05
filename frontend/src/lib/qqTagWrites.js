/**
 * QQ打标: likes written to the user's own QQ from this browser (2026-10-04).
 *
 * QQ打标 never reaches QQ from the site's address -- not to read, not to
 * write, not as a fallback. The page writes itself: the heart on a list and
 * the 待确认 button directly, and the automatic likes of a run when the
 * server offers them on this page's executor stream (it offers the phone
 * next, and otherwise leaves the capture in 待确认; see apkLikeService).
 *
 * Writes go through lib/qqDirectEngine's sandbox (JSONP, no Referer, no
 * cookie) with QQ's Android client fields -- the only shape QQ accepts a write
 * in without a cookie (tested on QQ, WeChat and app-scan accounts). Every
 * write is read back; only a state QQ confirms counts.
 *
 * One write at a time per page, and a heart pressed again before its first
 * press went out sends only the final state: QQ answers 2001 to the same song
 * flipped back and forth within seconds (it does not mind different songs in
 * quick succession: 5 in 3 s, tested).
 */
import { platformTaggingAPI, getPlatformTagSSEUrl } from "@/lib/api";
import * as reads from "@/lib/qqTagReads";

const LIKES_DIR_ID = 201;
const WRITE_TIMEOUT_MS = 10000;
// QQ's 2001: waited out once, when there is time for it.
const RETRY_2001_MS = 5000;

let engine = null;
async function loadEngine() {
  if (!engine) engine = await import("@/lib/qqDirectEngine");
  return engine;
}

/** What a code means to the user (the page shows err.message as it is). */
function messageFor(code) {
  if (code === 1000) return "QQ 登录已失效，请到 账户 → 音乐账号 重新扫码";
  if (code === 2001) return "QQ 说操作太频繁，请稍后再试";
  if (code === "timeout" || code === "script-error" || code === "bad-response") return "连不上 QQ 音乐，请重试";
  if (code === "partial") return "QQ 没有回答这首歌的状态，请重试";
  if (code === "not-applied") return "QQ 没有记下这次操作，请重试";
  if (code === "late") return "来不及了";
  return `QQ 没有接受（${code}），请稍后再试`;
}

function coded(code, message) {
  const e = new Error(message || messageFor(code));
  e.code = code;
  return e;
}

/** An engine failure (timeout, script-error, bad-response) in the user's words. */
function worded(err) {
  if (err && typeof err.code === "string" && !err.wordedForUser) {
    const e = coded(err.code);
    e.wordedForUser = true;
    return e;
  }
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The account values to write with after QQ answered 1000: fetched again (the
 * page's may just be old); if they are the same key, the server renews it (a
 * login only it can make). Null when nothing more can be done.
 */
async function freshAfter1000(s) {
  reads.dropSession();
  const fresh = await reads.readSession();
  if (fresh.musicKey !== s.musicKey) return fresh;
  return reads.renewAfterRefusal(s);
}

/** Is this song in 我喜欢? Read the way the lists are read. Retries once on a dead key. */
async function likedNow(ctx, id, count) {
  const m = await loadEngine();
  const ask = () => {
    count.calls += 1;
    return m.readQq(ctx.s, {
      module: "music.musicasset.SongFavRead",
      method: "IsSongFanById",
      param: { v_songId: [Number(id)] },
    });
  };
  let r;
  try { r = await ask(); } catch (err) { throw worded(err); }
  if (r.code === 1000 && !ctx.renewed) {
    ctx.renewed = true;
    const fresh = await freshAfter1000(ctx.s);
    if (fresh) {
      ctx.s = fresh;
      try { r = await ask(); } catch (err) { throw worded(err); }
    }
  }
  if (r.code !== 0) {
    if (r.code === 1000) reads.dropSession();
    throw coded(r.code);
  }
  const fan = (r.data && r.data.m_fan) || {};
  // QQ answers every id it is asked about; a missing one is not an answer.
  if (!(String(id) in fan)) throw coded("partial");
  return Boolean(fan[String(id)]);
}

/**
 * One write, with the two retries worth making: a dead key (once, after
 * fresh values or a renewal) and QQ's 2001 (once, after a pause) -- each
 * only while there is time.
 */
async function writeOnce(ctx, method, id, songType, count, deadline) {
  const m = await loadEngine();
  const send = () => {
    if (Date.now() > deadline) throw coded("late");
    count.calls += 1;
    return m.writeQq(ctx.s, {
      module: "music.musicasset.PlaylistDetailWrite",
      method,
      param: { dirId: LIKES_DIR_ID, tid: 0, bFmtUtf8: true, v_songInfo: [{ songId: Number(id), songType }] },
    }, WRITE_TIMEOUT_MS);
  };
  let r;
  try { r = await send(); } catch (err) { throw worded(err); }
  if (r.code === 1000 && !ctx.renewed && Date.now() < deadline) {
    ctx.renewed = true;
    const fresh = await freshAfter1000(ctx.s);
    if (fresh) {
      ctx.s = fresh;
      try { r = await send(); } catch (err) { throw worded(err); }
    }
  }
  if (r.code === 2001 && Date.now() + RETRY_2001_MS < deadline) {
    await sleep(RETRY_2001_MS);
    try { r = await send(); } catch (err) { throw worded(err); }
  }
  return r;
}

/**
 * Like or unlike one song, verified by reading back -- the same rules as the
 * server's own (qqSource.likeSong / unlikeSong). Resolves
 * { ok: true, alreadyLiked, calls }; rejects with an error in the user's words
 * carrying `calls`. Starts no write after `deadline`.
 */
async function perform({ op, id, songType = 0, precheck = false, deadline = Infinity }) {
  const count = { calls: 0 };
  try {
    const ctx = { s: await reads.readSession(), renewed: false };
    if (op === "like") {
      if (precheck && (await likedNow(ctx, id, count))) return { ok: true, alreadyLiked: true, calls: count.calls };
      const r = await writeOnce(ctx, "AddSonglist", id, Number(songType) || 0, count, deadline);
      if (r.code !== 0) throw coded(r.code);
      const ret = r.data && r.data.retCode;
      if (ret !== undefined && ret !== 0) throw coded(`retCode ${ret}`);
      if (!(await likedNow(ctx, id, count))) throw coded("not-applied");
      return { ok: true, alreadyLiked: false, calls: count.calls };
    }
    // Unlike: type 0 first (what QQ takes), then the song's own type. A
    // refusal other than a dead key does not end it -- the read-back is the
    // answer, as on the server.
    const attempt = async (type) => {
      const r = await writeOnce(ctx, "DelSonglist", id, type, count, deadline);
      if (r.code === 1000 || r.code === undefined) throw coded(r.code === undefined ? "bad-response" : 1000);
      return { removed: !(await likedNow(ctx, id, count)), code: r.code };
    };
    const first = await attempt(0);
    if (first.removed) return { ok: true, alreadyLiked: false, calls: count.calls };
    const own = Number(songType) || 0;
    const second = own !== 0 ? await attempt(own) : null;
    if (second && second.removed) return { ok: true, alreadyLiked: false, calls: count.calls };
    const bad = [first.code, second && second.code].find((c) => c !== undefined && c !== 0);
    throw bad !== undefined ? coded(bad) : coded("not-applied");
  } catch (err) {
    err.calls = count.calls;
    throw err;
  }
}

// One write at a time on this page.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.catch(() => {}).then(fn);
  chain = next.catch(() => {});
  return next;
}

/** A manual like/unlike not yet started, per song: a second press replaces its op. */
const waitingManual = new Map(); // id -> { op, promise }

/**
 * The heart on a list. Resolves { ok, alreadyLiked, op } -- `op` being what
 * was finally sent, when the heart was pressed again meanwhile.
 */
export function manual({ op, id, songType = 0 }) {
  const key = String(id);
  const waiting = waitingManual.get(key);
  if (waiting) {
    waiting.op = op;
    return waiting.promise;
  }
  const entry = { op };
  entry.promise = serial(async () => {
    waitingManual.delete(key);
    const res = await perform({ op: entry.op, id: key, songType, precheck: entry.op === "like" });
    // Every cached list on the server learns it (and the user-IP count).
    platformTaggingAPI.recorded({ op: entry.op, id: key, calls: res.calls }).catch(() => {});
    return { ...res, op: entry.op };
  });
  waitingManual.set(key, entry);
  return entry.promise;
}

/** The 待确认 button: like one candidate. Resolves { ok, alreadyLiked }, never rejects. */
export function approveLike({ id, songType = 0 }) {
  return serial(() => perform({ op: "like", id: String(id), songType, precheck: true }))
    .then((res) => ({ ok: true, alreadyLiked: res.alreadyLiked }))
    .catch((err) => ({ ok: false, alreadyLiked: false, message: err.message || "点赞失败" }));
}

/** An automatic like the server offered this page. */
async function take(cmdId) {
  let job;
  try {
    job = (await platformTaggingAPI.claimLike(cmdId)).data;
  } catch {
    return; // another tab took it, or it was withdrawn
  }
  const deadline = Date.now() + Math.max(0, Number(job.budgetMs) || 0);
  let body;
  try {
    let s = await reads.readSession();
    // The account the server holds now: a page holding an older one's values
    // fetches them again before writing anything.
    if (String(s.uin) !== String(job.uin)) {
      reads.dropSession();
      s = await reads.readSession();
      if (String(s.uin) !== String(job.uin)) throw coded("account-changed", "QQ 账号已变");
    }
    const res = await serial(() => perform({
      op: job.op, id: job.id, songType: job.songType, precheck: job.precheck, deadline,
    }));
    body = { cmdId, ok: true, alreadyLiked: res.alreadyLiked === true, calls: res.calls };
  } catch (err) {
    body = { cmdId, ok: false, code: String(err.code || "error"), calls: err.calls || 0 };
  }
  platformTaggingAPI.likeResult(body).catch(() => {});
}

/**
 * Take this run's automatic likes on this page, and hear when the server
 * needs the list read again (a restart lost it). Returns the stop function.
 * `onNeedList({ playlistRef })`; `onOpen()` on every (re)connect.
 */
export function startExecutor(sessionId, { onNeedList, onOpen } = {}) {
  let es = null;
  let stopped = false;
  let retryMs = 2000;
  let timer = null;
  const open = () => {
    if (stopped) return;
    es = new EventSource(getPlatformTagSSEUrl(sessionId, { exec: true }));
    es.addEventListener("open", () => { retryMs = 2000; if (onOpen) onOpen(); });
    es.addEventListener("qq-cmd", (e) => {
      let d = null;
      try { d = JSON.parse(e.data); } catch { /* malformed */ }
      if (d && typeof d.cmdId === "string") take(d.cmdId);
    });
    es.addEventListener("platform-tag-need-list", (e) => {
      let d = null;
      try { d = JSON.parse(e.data); } catch { /* malformed */ }
      if (d && d.sessionId === sessionId && onNeedList) onNeedList(d);
    });
    // The browser retries a dropped stream by itself, but gives up for good
    // when a retry is answered with an error (the 502 of a restarting
    // server): opened again here, with a growing pause.
    es.addEventListener("error", () => {
      if (stopped || !es || es.readyState !== 2) return;
      es.close();
      clearTimeout(timer);
      timer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    });
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (es) es.close();
  };
}
