/**
 * What the Content-Security-Policy would have blocked (2026-10-06).
 *
 * The policy is first sent as Report-Only: browsers block nothing and tell us
 * what they would have. Collected here, counted per (directive, blocked
 * origin, page) so a few days of traffic show which sources the policy is
 * missing before it is enforced.
 *
 * Only origins and paths are kept, never whole URLs: a blocked audio URL can
 * carry a QQ vkey, a page URL a token. In process memory, bounded; a restart
 * starting the tally again is fine.
 */

const MAX_KEYS = 300;
const tally = new Map(); // key -> { directive, blocked, page, count, first, last, sample }
const since = new Date().toISOString();

/** 'https://host' for a URL, or the keyword the browser sent (inline, eval, data, blob...). */
function originOf(uri) {
  const s = String(uri || '').trim();
  if (!s) return 'unknown';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s.split(':')[0].slice(0, 40); // inline, eval, data, blob, self
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'unparsable';
  }
}

/** The page's path only (no query, no fragment). */
function pathOf(uri) {
  try {
    return new URL(String(uri)).pathname.slice(0, 120);
  } catch {
    return 'unknown';
  }
}

/**
 * One violation, from either report format: the older `csp-report` object
 * (report-uri) or a Reporting API entry's `body` (report-to).
 */
function record(r) {
  if (!r || typeof r !== 'object') return;
  const directive = String(r['effective-directive'] || r.effectiveDirective
    || r['violated-directive'] || r.violatedDirective || 'unknown').split(' ')[0].slice(0, 40);
  const blocked = originOf(r['blocked-uri'] ?? r.blockedURL);
  const page = pathOf(r['document-uri'] ?? r.documentURL);
  const key = `${directive} ${blocked} @ ${page}`;
  const now = new Date().toISOString();
  let e = tally.get(key);
  if (!e) {
    if (tally.size >= MAX_KEYS) return;
    const sample = r['script-sample'] ?? r.sample;
    e = {
      directive, blocked, page, count: 0, first: now, last: now,
      sample: sample ? String(sample).slice(0, 40) : null,
    };
    tally.set(key, e);
    console.warn(`[csp] would block ${directive} ${blocked} on ${page}`);
  }
  e.count += 1;
  e.last = now;
}

/** A request body as browsers send it: one report object, or an array of Reporting API entries. */
function ingest(body) {
  if (Array.isArray(body)) {
    for (const entry of body.slice(0, 50)) {
      if (entry && entry.type === 'csp-violation') record(entry.body);
    }
  } else if (body && typeof body === 'object' && body['csp-report']) {
    record(body['csp-report']);
  }
}

function snapshot() {
  return {
    since,
    distinct: tally.size,
    reports: [...tally.values()].sort((a, b) => b.count - a.count),
  };
}

module.exports = { ingest, snapshot, originOf, pathOf };
