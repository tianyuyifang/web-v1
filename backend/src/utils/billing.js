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
 * Add N calendar months to a date, clamping the day-of-month to the target
 * month's last day (Jan 31 + 1 month -> Feb 28/29). All UTC.
 * @param {Date} from
 * @param {number} n - number of months (>= 0)
 * @returns {Date}
 */
function addMonths(from, n) {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);                       // avoid overflow while changing month
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * Add one calendar month (kept for existing callers).
 * @param {Date} from
 * @returns {Date}
 */
function addOneMonth(from) {
  return addMonths(from, 1);
}

/**
 * Add N days to a date. Plain 24h days, UTC. Used for arbitrary-length
 * activation codes (1 day / 1 week /任意天数); month/quarter codes use
 * addMonths so "1 month" tracks the calendar rather than a fixed 30.
 * @param {Date} from
 * @param {number} n - number of days (>= 0)
 * @returns {Date}
 */
function addDays(from, n) {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

module.exports = { deriveStatus, addOneMonth, addMonths, addDays };
