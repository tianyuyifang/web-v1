/**
 * Did a 唱卡 recording play? Counted per recording, singer and day, for
 * 「检查唱卡歌曲」 -- the on-demand check that finds songs a platform has
 * stopped serving (2026-11-11: 爱一直闪亮 and 生如逆旅 were refused by QQ for
 * days while 70 singers met them, and nothing on our side knew which songs).
 *
 * Evidence only. Nothing on the site reads this, so it can change no answer
 * and no page, and it never makes a request of its own: the browser's outcome
 * rides on the report it already sends every 20 seconds, the server's is
 * noted where it already resolved the song.
 *
 * `note` is synchronous, never throws and never waits: it adds to a map in
 * memory. One statement every FLUSH_MS writes the lot; a failed write is
 * logged once and dropped. A restart loses at most FLUSH_MS of counts, which
 * the check does not need -- it looks at days, not minutes.
 *
 * Deliberately no SIGINT/SIGTERM hook to flush on shutdown: a listener on
 * those signals stops Node exiting by itself, and pm2 then has to kill the
 * process (the failed restart of 2026-10-11 began exactly like that).
 */
const prisma = require('../db/client');

const FLUSH_MS = 5 * 60 * 1000;
/** Bound on memory between flushes: ~200 bytes each, so a few MB at most. */
const MAX_PENDING = 20000;
const KEEP_DAYS = 30;

const SOURCES = new Set(['QQ', 'NETEASE', 'LOCAL']);
const OUTCOMES = new Set(['ok', 'refused', 'failed']);
// QQ songmid, NetEase numeric id, LOCAL song uuid: all fit this.
const ID_RE = /^[0-9A-Za-z-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pending = new Map();
let timer = null;
let flushing = false;
let prunedOn = null;

const dayOf = (d) => d.toISOString().slice(0, 10); // UTC day

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

/**
 * Count one outcome. `outcome` is ok | refused | failed; `reason` is the
 * platform's word for a refusal (credential-expired, unavailable, ...).
 */
function note(arg) {
  try {
    // Unpacked in here, not in the signature: a bad argument must not throw.
    const { userId, source, externalId, outcome, reason = null } = arg || {};
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) return;
    if (!SOURCES.has(source) || !OUTCOMES.has(outcome)) return;
    if (typeof externalId !== 'string' || !ID_RE.test(externalId)) return;
    const at = new Date();
    const day = dayOf(at);
    const key = `${source}|${externalId}|${userId}|${day}`;
    let e = pending.get(key);
    if (!e) {
      if (pending.size >= MAX_PENDING) return;
      e = { source, externalId, userId, day, ok: 0, refused: 0, failed: 0, lastOkAt: null, lastRefusedAt: null, lastReason: null };
      pending.set(key, e);
    }
    e[outcome] += 1;
    if (outcome === 'ok') e.lastOkAt = at;
    if (outcome === 'refused') {
      e.lastRefusedAt = at;
      e.lastReason = typeof reason === 'string' ? reason.slice(0, 40) : null;
    }
    schedule();
  } catch { /* evidence only */ }
}

/**
 * The browser's samples (routes/qqDirect /report), reduced to outcomes. Only
 * samples that name their song count, so a page opened before this was
 * deployed simply adds nothing. A cache replay is not a new answer, and a
 * network failure (timeout, script-error, bad-response) says nothing about the
 * song, so neither is counted.
 */
function fromBrowser(samples, userId) {
  try {
    if (!Array.isArray(samples)) return;
    for (const s of samples.slice(0, 20)) {
      if (!s || typeof s !== 'object' || typeof s.mid !== 'string') continue;
      // Browser mode only. In shadow (测速) mode the server's URL is what
      // plays and resolvePreview has already counted it; the browser's probe
      // beside it would count the same play twice, and its own possibly stale
      // key can be refused while the song plays fine.
      if (s.mode !== 'browser') continue;
      const base = { userId, source: 'QQ', externalId: s.mid };
      if (s.playFailed === true) {
        // Only the player's own error: "notallowed" is Apple's autoplay rule
        // and "timeout" can be the network.
        if (s.failKind === 'error') note({ ...base, outcome: 'failed' });
      } else if (s.winner === 'direct') {
        // What finally happened, not QQ's first answer: a key that had just
        // died is renewed and QQ asked again, but directReason keeps the first
        // "credential-expired" -- with winner "direct", that song played.
        note({ ...base, outcome: 'ok' });
      } else if (s.winner === 'none' && (s.directReason === 'credential-expired' || s.directReason === 'unavailable')) {
        note({ ...base, outcome: 'refused', reason: s.directReason });
      }
    }
  } catch { /* evidence only */ }
}

async function flush() {
  if (flushing || !pending.size) return;
  flushing = true;
  const rows = [...pending.values()];
  pending = new Map();
  try {
    // Every column goes over as text and is cast here: arrays of numbers or
    // with nulls in them are refused in Prisma's binary encoding (22P03).
    const col = (f) => rows.map((r) => { const v = f(r); return v == null ? null : String(v); });
    // Rows for a singer deleted since are dropped by the join instead of
    // failing the whole statement on the foreign key.
    await prisma.$executeRawUnsafe(
      `INSERT INTO track_plays (source, external_id, user_id, day, ok, refused, failed, last_ok_at, last_refused_at, last_reason)
       SELECT t.source::"SongSource", t.external_id, t.user_id::uuid, t.day::date, t.ok::int, t.refused::int, t.failed::int,
              t.last_ok_at::timestamptz, t.last_refused_at::timestamptz, t.last_reason
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                     $8::text[], $9::text[], $10::text[])
              AS t(source, external_id, user_id, day, ok, refused, failed, last_ok_at, last_refused_at, last_reason)
         JOIN users u ON u.id = t.user_id::uuid
       ON CONFLICT (source, external_id, user_id, day) DO UPDATE SET
         ok = track_plays.ok + EXCLUDED.ok,
         refused = track_plays.refused + EXCLUDED.refused,
         failed = track_plays.failed + EXCLUDED.failed,
         last_ok_at = GREATEST(track_plays.last_ok_at, EXCLUDED.last_ok_at),
         last_refused_at = GREATEST(track_plays.last_refused_at, EXCLUDED.last_refused_at),
         last_reason = COALESCE(EXCLUDED.last_reason, track_plays.last_reason)`,
      col((r) => r.source), col((r) => r.externalId), col((r) => r.userId), col((r) => r.day),
      col((r) => r.ok), col((r) => r.refused), col((r) => r.failed),
      col((r) => (r.lastOkAt ? r.lastOkAt.toISOString() : null)),
      col((r) => (r.lastRefusedAt ? r.lastRefusedAt.toISOString() : null)),
      col((r) => r.lastReason)
    );
  } catch (err) {
    console.warn(`[trackPlayLog] ${rows.length} rows dropped: ${String(err && err.message).slice(0, 200)}`);
  }
  // Pruning has its own catch: a failed delete is not a failed write.
  try {
    const today = dayOf(new Date());
    if (prunedOn !== today) {
      prunedOn = today;
      await prisma.$executeRawUnsafe(`DELETE FROM track_plays WHERE day < current_date - ${KEEP_DAYS}`);
    }
  } catch (err) {
    console.warn(`[trackPlayLog] pruning rows older than ${KEEP_DAYS} days failed: ${String(err && err.message).slice(0, 200)}`);
  } finally {
    flushing = false;
    if (pending.size) schedule();
  }
}

module.exports = { note, fromBrowser, flush, _pendingSize: () => pending.size };
