/**
 * The push channel to the capture client (APK).
 *
 * The client learned where captures go only from its heartbeat, every 25s, so
 * for up to that long after the user switched rounds on the site it kept
 * reading the old round's screens. A 唱卡 picking screen is open for about
 * five seconds, so songs in that window were simply never read. Polling
 * faster, piggybacking and long polling were all ruled out earlier; this is
 * the SSE stream the site already uses for its own pages, opened by the client
 * itself.
 *
 * Opened only while the session is aimed at QQ打标 on QQ and the admin switch
 * (档位设置 → QQ打标 点赞) allows it for this user -- the client is told so in
 * `stream` and opens nothing otherwise. Every other round behaves exactly as
 * before.
 *
 * Carries two kinds of message: `target` (where captures go now) and `cmd` (a
 * QQ like for the phone to perform; see apkLikeService).
 */
const prisma = require('../db/client');
const settingsService = require('./settingsService');
const { addClient, broadcast, countClients } = require('./sseManager');
const { clientTarget } = require('./captureRouting');

function channel(sessionId) {
  return `apk:${sessionId}`;
}

/** sessionId -> { res, version, caps:Set } for the stream currently open. */
const streams = new Map();

/**
 * Whether this session's client should hold the stream open: aimed at QQ打标
 * on QQ, with the switch on for this user. Fails closed -- any error reads as
 * "no stream", which is the behaviour before this existed.
 */
async function wantsStream(session) {
  try {
    if (session.target !== 'platform') return false;
    if (!String(session.platformRef || '').startsWith('qq:')) return false;
    const s = await settingsService.getApkLikes();
    if (!s.enabled) return false;
    if (!s.adminsOnly) return true;
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { role: true } });
    return Boolean(user && user.role === 'ADMIN');
  } catch {
    return false;
  }
}

/** clientTarget plus whether to hold the stream open. */
async function targetFor(session) {
  return { ...clientTarget(session), stream: await wantsStream(session) };
}

/**
 * Register a client's stream, and tell it at once where captures go now.
 * Refused (false) when the session should not have one -- the stream is the
 * way to the user's QQ credential, so it is only ever open when needed.
 */
async function attach(session, res, { version = null, caps = [] } = {}) {
  if (!await wantsStream(session)) return false;
  addClient(channel(session.id), res, `apk:${session.id}`);
  const entry = { res, version, caps: new Set(caps) };
  streams.set(session.id, entry);
  const forget = () => {
    if (streams.get(session.id) === entry) streams.delete(session.id);
  };
  res.on('close', forget);
  if (res.socket) res.socket.on('close', forget);
  // The first message, so a reconnect never misses a switch made while the
  // stream was down. Read fresh: the copy the request carries can predate a
  // switch made while this stream was being set up, and sending it would
  // undo the newer one on the phone.
  const now = await prisma.captureSession.findUnique({ where: { id: session.id } }).catch(() => null);
  broadcast(channel(session.id), 'target', await targetFor(now || session));
  return true;
}

/** Can this session's phone take a command of this kind right now? */
function canRun(sessionId, cap) {
  const s = streams.get(sessionId);
  return Boolean(s && s.caps.has(cap) && countClients(channel(sessionId)) > 0);
}

/**
 * The session's destination changed: say so on the stream, if one is open.
 * Never throws -- a failed push costs only the speed-up; the heartbeat still
 * carries the same answer within 25s.
 */
async function pushTarget(session) {
  try {
    if (!session || countClients(channel(session.id)) === 0) return;
    broadcast(channel(session.id), 'target', await targetFor(session));
  } catch (err) {
    console.warn('[apk] target push failed:', err.message);
  }
}

function send(sessionId, event, data) {
  broadcast(channel(sessionId), event, data);
}

module.exports = {
  channel, attach, canRun, pushTarget, targetFor, wantsStream, send,
};
