/**
 * QQ打标 likes, performed from the user's own address -- never this server's.
 *
 * Since 2026-10-04 QQ打标 talks to QQ only from the user's browser or phone,
 * with no fallback to the site's address (platformLikeService refuses QQ
 * outright). A like the capture path decides on is offered, in turn, to:
 *
 *   1. the QQ打标 page, when one is open with its executor stream connected
 *      (it writes through its own JSONP sandbox, lib/qqTagWrites);
 *   2. the capture client on the phone, when its push stream is open and able
 *      (APK v28+, QqWriter) and the 手机执行 switch allows it;
 *
 * and when neither takes it, the caller is told so (NO_USER_IP_EXECUTOR) and
 * the capture waits in 待确认 for the user. Likes the user makes on the page
 * (the heart, the 待确认 button) are written by the page itself and only
 * reported here -- see routes/platformTagging.
 *
 * NetEase cannot be reached from a browser at all; its likes are the server's,
 * as before, and the whole of 网易云打标 is behind its own switch.
 *
 * The exchange with either executor is claim-then-act, so two never write for
 * one command unless the first has already started:
 *
 *   server  --cmd {cmdId, op}-->        executor  (SSE, no secret in it)
 *   executor --POST claim {cmdId}-->    server    -> song (+ phone: credential)
 *   executor writes to QQ, reads it back
 *   executor --POST result {cmdId, ok}--> server
 *
 * Unclaimed after CLAIM_MS: withdrawn (a late claim is refused) and offered
 * to the next. Claimed but no result in time: the next is offered it too.
 * Writes are idempotent on QQ (adding a liked song changes nothing; the state
 * is read back either way), so the rare overlap is harmless.
 */
const crypto = require('crypto');
const prisma = require('../db/client');
const likes = require('./platformLikeService');
const access = require('./musicCredentialAccess');
const settingsService = require('./settingsService');
const apkChannel = require('./apkChannel');
const meter = require('./outboundMeter');
const { broadcast } = require('./sseManager');
const { AppError } = require('../utils/errors');

const CLAIM_MS = 2500;
// The phone's window (its budget logic is built around this, APK v28).
const RESULT_MS = 6000;
// The page's: room to wait out QQ's 2001 once (5 s) when its first write
// answered quickly. Kept so page + phone together (2.5 + 8 + 2.5 + 6 s) stay
// inside the capture client's 20 s ingest wait.
const PAGE_RESULT_MS = 8000;
/** Allowance for the claim reply's trip to the executor, taken off its budget. */
const CLAIM_REPLY_MARGIN_MS = 1000;
const CAP = 'qqlike';

/** cmdId -> command; only while in flight. */
const pending = new Map();

/** userId -> Set of open executor streams (QQ打标 pages that can write). */
const pageExecutors = new Map();

// --- counters for the admin panel (process memory, since the last restart) ---
const stats = {
  since: new Date().toISOString(),
  byPurpose: {}, // purpose -> { page, phone, unclaimed, timeout, failed, noExecutor, ... }
  phoneMs: [], // last 200 executor round trips, push to result
  fallback: { ok: 0, failed: 0 }, // kept for the admin page; no server fallback for QQ any more
  failCodes: {},
};

function bump(purpose, key) {
  const p = stats.byPurpose[purpose] || (stats.byPurpose[purpose] = {});
  p[key] = (p[key] || 0) + 1;
}

function percentile(list, q) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function snapshot() {
  return {
    since: stats.since,
    byPurpose: stats.byPurpose,
    phoneMs: { n: stats.phoneMs.length, p50: percentile(stats.phoneMs, 0.5), p90: percentile(stats.phoneMs, 0.9) },
    fallback: stats.fallback,
    failCodes: stats.failCodes,
    inFlight: pending.size,
    pagesOpen: [...pageExecutors.values()].reduce((n, set) => n + set.size, 0),
  };
}

// --- the page as executor -------------------------------------------------------

/**
 * A QQ打标 page opened its executor stream. Kept while the response is open,
 * so "a page can take this" is known without asking it.
 */
function attachPageExecutor(userId, res) {
  let set = pageExecutors.get(userId);
  if (!set) pageExecutors.set(userId, (set = new Set()));
  set.add(res);
  const forget = () => {
    set.delete(res);
    if (!set.size && pageExecutors.get(userId) === set) pageExecutors.delete(userId);
  };
  // Only the response's own close: a listener on the socket would pile up
  // on a reused upstream connection. A socket that dies silently is pruned
  // by pageAvailable.
  res.once('close', forget);
}

function pageAvailable(userId) {
  const set = pageExecutors.get(userId);
  if (!set) return false;
  // A stream whose socket died without a close event (behind a proxy that
  // happens) is dropped here, so it does not cost each like a claim wait.
  for (const res of set) if (res.destroyed || res.writableEnded) set.delete(res);
  if (!set.size) pageExecutors.delete(userId);
  return set.size > 0;
}

/** The same channel platformTagService broadcasts on (not required here: a cycle). */
function pageChannel(userId) {
  return `platform-tag:${userId}`;
}

// --- the phone as executor --------------------------------------------------------

/**
 * The 手机执行 switch's settings when they apply to this user, else null.
 * Fails closed: any error reads as "phone not used".
 */
async function switchFor(userId, platform) {
  try {
    if (platform !== 'qq') return null;
    const s = await settingsService.getApkLikes();
    if (!s.enabled) return null;
    if (s.adminsOnly) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (!user || user.role !== 'ADMIN') return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** The session whose phone can take this like now, or null. */
async function phoneFor(userId, s, purpose, sessionHint) {
  try {
    if (!s || !s[purpose]) return null;
    if (sessionHint && sessionHint.userId === userId && apkChannel.canRun(sessionHint.id, CAP)) {
      return sessionHint;
    }
    const session = await prisma.captureSession.findFirst({
      where: { userId, endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return session && apkChannel.canRun(session.id, CAP) ? session : null;
  } catch {
    return null;
  }
}

// --- one offer to one executor ----------------------------------------------------

/**
 * Offer a command to one executor. Resolves { ok: true, result } once it has
 * done it, or { ok: false, why } -- never rejects.
 */
function offer({ executor, userId, session = null, purpose, op, args }) {
  return new Promise((resolve) => {
    const cmd = {
      id: crypto.randomUUID(),
      executor,
      userId,
      sessionId: session ? session.id : null,
      purpose,
      op,
      songId: String(args.id),
      songType: Number(args.songType) || 0,
      // A like the caller has not just checked is checked by the executor first.
      precheck: op === 'like' && !args.knownUnliked,
      state: 'sent',
      sentAt: Date.now(),
      resultMs: executor === 'page' ? PAGE_RESULT_MS : RESULT_MS,
      timer: null,
    };
    const settle = (value) => {
      clearTimeout(cmd.timer);
      pending.delete(cmd.id);
      resolve(value);
    };
    cmd.fail = (why) => {
      if (cmd.state === 'done' || cmd.state === 'withdrawn') return;
      cmd.state = 'withdrawn';
      bump(purpose, `${executor}:${why}`);
      console.log(`[userip-like] ${op} ${cmd.songId} ${executor} -> ${why}`);
      settle({ ok: false, why });
    };
    cmd.done = (result) => {
      if (cmd.state === 'done' || cmd.state === 'withdrawn') return;
      cmd.state = 'done';
      const ms = Date.now() - cmd.sentAt;
      stats.phoneMs.push(ms);
      if (stats.phoneMs.length > 200) stats.phoneMs.shift();
      bump(purpose, executor);
      console.log(`[userip-like] ${op} ${cmd.songId} by ${executor} in ${ms}ms${result.alreadyLiked ? ' (already liked)' : ''}`);
      settle({ ok: true, result });
    };
    pending.set(cmd.id, cmd);
    cmd.timer = setTimeout(() => { if (cmd.state === 'sent') cmd.fail('unclaimed'); }, CLAIM_MS);
    if (executor === 'page') broadcast(pageChannel(userId), 'qq-cmd', { cmdId: cmd.id, op });
    else apkChannel.send(session.id, 'cmd', { cmdId: cmd.id, op });
  });
}

/**
 * One user's likes and unlikes, one at a time, whoever performs them: an
 * unlike must not land after a later like, and QQ answers 2001 to the same
 * song flipped back and forth within seconds.
 */
const queues = new Map(); // userId -> Promise

function inOrder(userId, fn) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(userId, next);
  next.catch(() => {}).finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  return next;
}

function noExecutor(tried) {
  const triedPage = tried.some((t) => t.startsWith('page:') && t !== 'page:closed');
  const triedPhone = tried.some((t) => t.startsWith('phone:') && t !== 'phone:offline');
  const refused = tried.some((t) => t.endsWith(':failed'));
  const message = refused
    ? '没能点赞：QQ 没有接受（网站不会代点），请稍后在网页上重试'
    : triedPage || triedPhone
      ? '没能点赞：打标网页/手机没有及时完成（网站不会代点），请在网页上确认'
      : '没能点赞：打标网页和手机都不在线（网站不会代点），请在网页上确认';
  const e = new AppError(message, 503);
  e.code = 'NO_USER_IP_EXECUTOR';
  e.tried = tried;
  return e;
}

async function perform(op, userId, platform, args, purpose, session) {
  // NetEase: the server's, as it always was (the route gates 网易云打标).
  if (platform !== 'qq') {
    return op === 'like' ? likes.like(userId, platform, args) : likes.unlike(userId, platform, args);
  }
  return inOrder(userId, async () => {
    const tried = [];
    if (pageAvailable(userId)) {
      const r = await offer({ executor: 'page', userId, purpose, op, args });
      if (r.ok) return r.result;
      tried.push(`page:${r.why}`);
    } else {
      tried.push('page:closed');
    }
    const phone = await phoneFor(userId, await switchFor(userId, platform), purpose, session);
    if (phone) {
      const r = await offer({ executor: 'phone', userId, session: phone, purpose, op, args });
      if (r.ok) return r.result;
      tried.push(`phone:${r.why}`);
    } else {
      tried.push('phone:offline');
    }
    bump(purpose, 'noExecutor');
    throw noExecutor(tried);
  });
}

/** Same contract as platformLikeService.like, plus who is asking. */
function like(userId, platform, args, { purpose, session = null } = {}) {
  return perform('like', userId, platform, args, purpose, session);
}

/** Same contract as platformLikeService.unlike, plus who is asking. */
function unlike(userId, platform, args, { purpose, session = null } = {}) {
  return perform('unlike', userId, platform, args, purpose, session);
}

// --- claims and results -----------------------------------------------------------

function arm(cmd) {
  cmd.state = 'claimed';
  cmd.claimedAt = Date.now();
  clearTimeout(cmd.timer);
  cmd.timer = setTimeout(() => { if (cmd.state === 'claimed') cmd.fail('timeout'); }, cmd.resultMs);
}

function budget(cmd) {
  // What is left of the window, less a margin for the reply's trip: the
  // executor starts no write after this.
  return Math.max(0, cmd.resultMs - (Date.now() - cmd.claimedAt) - CLAIM_REPLY_MARGIN_MS);
}

/**
 * The phone takes a command. Returns what it needs to act, or null when the
 * command is not its to take (withdrawn, someone else's, already taken).
 */
async function claim(session, cmdId) {
  const cmd = pending.get(String(cmdId || ''));
  if (!cmd || cmd.executor !== 'phone' || cmd.sessionId !== session.id || cmd.state !== 'sent') return null;
  // Armed now, not after the credential read: a renewal inside that read can
  // take seconds, and the command must not sit without a deadline meanwhile.
  arm(cmd);
  let cred = null;
  try {
    cred = await access.getFreshCredential(cmd.userId, 'qq');
  } catch {
    cred = null;
  }
  // Withdrawn while the credential was read? Then it is no longer the phone's.
  if (cmd.state !== 'claimed') return null;
  if (!cred || !cred.cookie || !cred.uin || !cred.musicKey) {
    cmd.fail('noCredential');
    return null;
  }
  return {
    op: cmd.op,
    id: cmd.songId,
    songType: cmd.songType,
    precheck: cmd.precheck,
    budgetMs: budget(cmd),
    cred: { cookie: cred.cookie, uin: String(cred.uin), musicKey: cred.musicKey },
  };
}

/**
 * A page takes a command. No credential in the answer: the page holds its own
 * account values (qq-read-session) and checks they are for `uin`.
 */
async function claimPage(userId, cmdId) {
  const cmd = pending.get(String(cmdId || ''));
  if (!cmd || cmd.executor !== 'page' || cmd.userId !== userId || cmd.state !== 'sent') return null;
  arm(cmd);
  let cred = null;
  try {
    cred = await access.getFreshCredential(userId, 'qq');
  } catch {
    cred = null;
  }
  if (cmd.state !== 'claimed') return null;
  if (!cred || !cred.uin) {
    cmd.fail('noCredential');
    return null;
  }
  return {
    op: cmd.op,
    id: cmd.songId,
    songType: cmd.songType,
    precheck: cmd.precheck,
    budgetMs: budget(cmd),
    uin: String(cred.uin),
  };
}

function settleResult(cmd, body) {
  const b = body || {};
  // Counted whatever the outcome: these requests left from the user's address.
  const calls = Number.isInteger(b.calls) ? Math.min(b.calls, 20) : 0;
  if (calls > 0) meter.recordUserIp('qq', calls);
  if (b.ok === true) {
    cmd.done(cmd.op === 'like' ? { ok: true, alreadyLiked: b.alreadyLiked === true } : { ok: true });
  } else {
    const code = String(b.code == null ? 'unknown' : b.code).slice(0, 40);
    stats.failCodes[code] = (stats.failCodes[code] || 0) + 1;
    // Out of time, or holding another account's values: the executor did not
    // try, so QQ did not refuse -- the next one is asked, and with nobody
    // left the capture waits in 待确认 rather than showing as failed.
    cmd.fail(code === 'late' || code === 'account-changed' ? 'unavailable' : 'failed');
  }
  return true;
}

/** The phone's answer. */
function result(session, cmdId, body) {
  const cmd = pending.get(String(cmdId || ''));
  if (!cmd || cmd.executor !== 'phone' || cmd.sessionId !== session.id || cmd.state !== 'claimed') return false;
  return settleResult(cmd, body);
}

/** A page's answer. */
function resultPage(userId, cmdId, body) {
  const cmd = pending.get(String(cmdId || ''));
  if (!cmd || cmd.executor !== 'page' || cmd.userId !== userId || cmd.state !== 'claimed') return false;
  return settleResult(cmd, body);
}

module.exports = {
  like, unlike, claim, result, claimPage, resultPage, attachPageExecutor, pageAvailable, snapshot, CAP,
  // For tests.
  _pending: pending, CLAIM_MS, RESULT_MS, PAGE_RESULT_MS,
};
