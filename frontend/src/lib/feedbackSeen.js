/**
 * Whether there is a reply the user has not looked at yet.
 *
 * Kept in localStorage rather than a database column: the whole feature is one
 * dot, and a read-state table would need its own writes, its own cleanup, and
 * a decision about what "read" means across devices. The cost of storing it
 * locally is that a new browser shows the dot once more — cheap next to a
 * table, for a site where a handful of replies are written a month.
 *
 * One module so the dot and the list agree on the key. Two copies of this
 * string would drift, and the dot would then either never clear or never show.
 */
const KEY = "feedback-replies-seen";

/** The newest reply time in a list of feedback, or 0 if none is answered. */
export function newestReplyAt(rows) {
  return (rows || []).reduce((max, f) => {
    const t = f.repliedAt ? new Date(f.repliedAt).getTime() : 0;
    return Number.isFinite(t) && t > max ? t : max;
  }, 0);
}

export function lastSeenAt() {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    // Private mode: treat as never seen, so the dot shows rather than hides.
    return 0;
  }
}

export function markSeen(rows) {
  const newest = newestReplyAt(rows);
  if (!newest) return;
  try {
    localStorage.setItem(KEY, String(newest));
  } catch {
    // Nothing to do; the dot simply reappears next visit.
  }
}

/** True when something has been answered since the user last looked. */
export function hasUnreadReply(rows) {
  return newestReplyAt(rows) > lastSeenAt();
}
