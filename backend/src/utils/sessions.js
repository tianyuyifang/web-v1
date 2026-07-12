// Pure helpers for the per-user active-session list.
// A session entry is { sid: string, createdAt: string (ISO) }.

function normalizeSessions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e.sid === 'string' && typeof e.createdAt === 'string')
    .map((e) => ({ sid: e.sid, createdAt: e.createdAt }));
}

// Append {sid, createdAt: nowIso}, then keep the newest `limit` by createdAt.
// limit === Infinity => no trimming.
function addSession(list, sid, nowIso, limit) {
  const next = normalizeSessions(list).concat({ sid, createdAt: nowIso });
  if (!Number.isFinite(limit)) return next;
  if (next.length <= limit) return next;
  // Sort ascending by createdAt, keep the newest `limit` (evict the oldest).
  const sorted = [...next].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  );
  return sorted.slice(sorted.length - limit);
}

function hasSession(list, sid) {
  return normalizeSessions(list).some((e) => e.sid === sid);
}

module.exports = { normalizeSessions, addSession, hasSession };
