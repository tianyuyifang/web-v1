/**
 * Derive subscription status from an expiration date.
 * @param {Date|string|null} expiresAt
 * @param {Date} [now]
 * @returns {'active'|'expired'}
 */
function deriveStatus(expiresAt, now = new Date()) {
  if (!expiresAt) return 'active';
  const exp = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return exp.getTime() > now.getTime() ? 'active' : 'expired';
}

/**
 * Add one calendar month to a date, clamping the day-of-month to the
 * target month's last day (Jan 31 -> Feb 28/29).
 * @param {Date} from
 * @returns {Date}
 */
function addOneMonth(from) {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);                       // avoid overflow while changing month
  d.setUTCMonth(d.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

module.exports = { deriveStatus, addOneMonth };
