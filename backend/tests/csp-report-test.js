/**
 * cspReports: both report formats are counted, and nothing but origins and
 * paths is kept (a blocked URL can carry a QQ vkey, a page URL a token).
 * Run: node tests/csp-report-test.js
 */
const assert = require('assert');
const csp = require('../src/services/cspReports');

// report-uri format
csp.ingest({ 'csp-report': {
  'document-uri': 'https://qnicheatsheet.com/live?token=SECRET1',
  'violated-directive': 'connect-src',
  'effective-directive': 'connect-src',
  'blocked-uri': 'https://evil.example.com/x?k=SECRET2',
} });
// Reporting API format (an array of entries)
csp.ingest([{ type: 'csp-violation', body: {
  documentURL: 'https://qnicheatsheet.com/live?token=SECRET1',
  effectiveDirective: 'connect-src',
  blockedURL: 'https://evil.example.com/y?k=SECRET3',
} }, { type: 'deprecation', body: {} }]);
// an inline script
csp.ingest({ 'csp-report': { 'document-uri': 'https://qnicheatsheet.com/', 'violated-directive': 'script-src-elem', 'blocked-uri': 'inline', 'script-sample': 'alert(1)' } });
// junk
csp.ingest(null);
csp.ingest('x');
csp.ingest({ nope: 1 });

const snap = csp.snapshot();
const text = JSON.stringify(snap);
assert.ok(!/SECRET/.test(text), 'no query string, token or key is kept');
const evil = snap.reports.find((r) => r.blocked === 'https://evil.example.com');
assert.ok(evil && evil.count === 2 && evil.page === '/live' && evil.directive === 'connect-src', 'both formats counted together, by origin and path');
const inline = snap.reports.find((r) => r.blocked === 'inline');
assert.ok(inline && inline.directive === 'script-src-elem' && inline.sample === 'alert(1)', 'inline violations kept with a short sample');
assert.strictEqual(snap.distinct, 2, 'junk ignored');

// bounded
for (let i = 0; i < 400; i += 1) {
  csp.ingest({ 'csp-report': { 'document-uri': `https://a.b/p${i}`, 'violated-directive': 'img-src', 'blocked-uri': `https://h${i}.example.com/` } });
}
assert.ok(csp.snapshot().distinct <= 300, 'at most 300 distinct entries');

console.log('csp-report-test: all passed');
