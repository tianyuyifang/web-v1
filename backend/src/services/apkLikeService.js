/**
 * QQ打标 likes performed by the user's own phone.
 *
 * A drop-in for platformLikeService.like / unlike: same arguments, same result,
 * same errors. When the phone may take the like (switch on for this user and
 * this kind of like, QQ, the capture client's stream open and able), the
 * command goes to the phone, which writes to QQ from the user's own network.
 * Otherwise -- and whenever the phone does not finish in time, or reports a
 * failure -- the server does it exactly as it always has.
 *
 * The exchange is claim-then-act, so the phone and the fallback never both
 * write for one command unless the phone has already started:
 *
 *   server  --cmd {cmdId, op}-->            phone      (SSE, no secret in it)
 *   phone   --POST claim {cmdId}-->         server     -> credential, song
 *   phone   writes to QQ, reads it back
 *   phone   --POST result {cmdId, ok}-->    server
 *
 * Unclaimed after CLAIM_MS: the command is withdrawn (a late claim is refused)
 * and the server likes it. Claimed but no result after RESULT_MS: the server
 * likes it too. Both writes are idempotent on QQ (adding a liked song changes
 * nothing; the state is read back either way), so the rare overlap is harmless.
 */
const crypto = require('crypto');
const prisma = require('../db/client');
const likes = require('./platformLikeService');
const access = require('./musicCredentialAccess');
const settingsService = require('./settingsService');
const apkChannel = require('./apkChannel');
const meter = require('./outboundMeter');

const CLAIM_MS = 2500;
const RESULT_MS = 6000;
/** Allowance for the claim reply's trip to the phone, taken off its budget. */
const CLAIM_REPLY_MARGIN_MS = 1000;
const CAP = 'qqlike';

/** cmdId -> command; only while in flight. */
const pending = new Map();

// --- counters for the admin panel (process memory, since the last restart) ---
const stats = {
  since: new Date().toISOString(),
  byPurpose: {}, // purpose -> { phone, unclaimed, timeout, phoneFailed, noCredential }
  phoneMs: [], // last 200 phone round trips, push to result
  fallback: { ok: 0, failed: 0 },
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
  };
}

/**
 * The switch's settings when they apply to this user and platform, else null.
 * Fails closed: any error reads as "off", which is the behaviour before.
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

/**
 * The session whose phone should take this like, or null for the server.
 * Fails closed: any error reads as "server", which is the behaviour before.
 */
async function phoneFor(userId, s, purpose, sessionHint) {
  try {
    if (!s[purpose]) return null;
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

function runOnPhone(session, purpose, op, args, serverPath) {
  return new Promise((resolve, reject) => {
    const cmd = {
      id: crypto.randomUUID(),
      userId: session.userId,
      sessionId: session.id,
      purpose,
      op,
      songId: String(args.id),
      songType: Number(args.songType) || 0,
      // A like the caller has not just checked is checked by the phone first,
      // as the server path does (platformLikeService.like knownUnliked).
      precheck: op === 'like' && !args.knownUnliked,
      state: 'sent',
      sentAt: Date.now(),
      timer: null,
    };

    const settle = (fn) => {
      clearTimeout(cmd.timer);
      pending.delete(cmd.id);
      fn();
    };

    cmd.toServer = (why) => {
      cmd.state = 'server';
      bump(purpose, why);
      console.log(`[apklike] ${op} ${cmd.songId} -> server (${why})`);
      settle(() => {
        serverPath().then((res) => {
          stats.fallback.ok += 1;
          resolve(res);
        }, (err) => {
          stats.fallback.failed += 1;
          reject(err);
        });
      });
    };

    cmd.done = (result) => {
      cmd.state = 'done';
      const ms = Date.now() - cmd.sentAt;
      stats.phoneMs.push(ms);
      if (stats.phoneMs.length > 200) stats.phoneMs.shift();
      bump(purpose, 'phone');
      console.log(`[apklike] ${op} ${cmd.songId} by phone in ${ms}ms${result.alreadyLiked ? ' (already liked)' : ''}`);
      settle(() => resolve(result));
    };

    pending.set(cmd.id, cmd);
    cmd.timer = setTimeout(() => {
      if (cmd.state === 'sent') cmd.toServer('unclaimed');
    }, CLAIM_MS);
    apkChannel.send(session.id, 'cmd', { cmdId: cmd.id, op });
  });
}

/**
 * One user's likes and unlikes, one at a time, whoever performs them --
 * while the switch is on. The server's own writes are already queued per user
 * (platformLikeService); a phone write is not in that queue, so without this
 * a slow phone unlike could land after a later like the user made by hand.
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

async function perform(op, userId, platform, args, purpose, session) {
  const serverPath = () => (op === 'like'
    ? likes.like(userId, platform, args)
    : likes.unlike(userId, platform, args));
  const s = await switchFor(userId, platform);
  // Switch off, or off for this kind of like: exactly the call it always was,
  // and never queued behind a slow phone.
  if (!s || !s[purpose]) return serverPath();
  return inOrder(userId, async () => {
    const phone = await phoneFor(userId, s, purpose, session);
    return phone ? runOnPhone(phone, purpose, op, args, serverPath) : serverPath();
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

/**
 * The phone takes a command. Returns what it needs to act, or null when the
 * command is not its to take (withdrawn, someone else's, already taken).
 */
async function claim(session, cmdId) {
  const cmd = pending.get(String(cmdId || ''));
  if (!cmd || cmd.sessionId !== session.id || cmd.state !== 'sent') return null;
  cmd.state = 'claimed';
  cmd.claimedAt = Date.now();
  clearTimeout(cmd.timer);
  // Armed now, not after the credential read: a renewal inside that read can
  // take seconds, and the command must not sit without a deadline meanwhile.
  cmd.timer = setTimeout(() => {
    if (cmd.state === 'claimed') cmd.toServer('timeout');
  }, RESULT_MS);

  let cred = null;
  try {
    cred = await access.getFreshCredential(cmd.userId, 'qq');
  } catch {
    cred = null;
  }
  // Withdrawn while the credential was read? Then it is no longer the phone's.
  if (cmd.state !== 'claimed') return null;
  if (!cred || !cred.cookie || !cred.uin || !cred.musicKey) {
    cmd.toServer('noCredential');
    return null;
  }
  return {
    op: cmd.op,
    id: cmd.songId,
    songType: cmd.songType,
    precheck: cmd.precheck,
    // What is left of the window before the server does it itself, less a
    // margin for the reply's trip: the phone starts no write after this. The
    // window is counted from the claim, so a slow credential read above eats
    // into it rather than pushing the phone's writes past the fallback.
    budgetMs: Math.max(0, RESULT_MS - (Date.now() - cmd.claimedAt) - CLAIM_REPLY_MARGIN_MS),
    cred: { cookie: cred.cookie, uin: String(cred.uin), musicKey: cred.musicKey },
  };
}

/** The phone's answer. Anything but a verified success goes to the server. */
function result(session, cmdId, body) {
  const cmd = pending.get(String(cmdId || ''));
  if (!cmd || cmd.sessionId !== session.id || cmd.state !== 'claimed') return false;
  const b = body || {};
  // Counted whatever the outcome: these requests left from the user's address.
  const calls = Number.isInteger(b.calls) ? b.calls : 0;
  if (calls > 0) meter.recordUserIp('qq', calls);
  if (b.ok === true) {
    cmd.done(cmd.op === 'like'
      ? { ok: true, alreadyLiked: b.alreadyLiked === true }
      : { ok: true });
  } else {
    const code = String(b.code == null ? 'unknown' : b.code).slice(0, 40);
    stats.failCodes[code] = (stats.failCodes[code] || 0) + 1;
    cmd.toServer('phoneFailed');
  }
  return true;
}

module.exports = {
  like, unlike, claim, result, snapshot, CAP,
  // For tests.
  _pending: pending, CLAIM_MS, RESULT_MS,
};
