/**
 * outboundMeter — offline.
 * Run: node tests/outbound-meter-test.js
 */
const assert = require('assert');
const meter = require('../src/services/outboundMeter');

meter.reset();
const t0 = Date.UTC(2026, 8, 27, 12, 0, 5); // 12:00:05Z

// Counted per kind, per minute and per day.
meter.record('qq', 'read', t0);
meter.record('qq', 'read', t0 + 1000);
meter.record('qq', 'write', t0 + 2000);
meter.record('qq', 'lyric', t0 + 3000);
meter.record('qq', 'bogus', t0 + 4000); // unknown kinds count as reads
let s = meter.snapshot(t0 + 5000);
assert.deepStrictEqual(s.qq.thisMinute, { read: 3, write: 1, lyric: 1, login: 0, probe: 0 });
assert.deepStrictEqual(s.qq.today, { read: 3, write: 1, lyric: 1, login: 0, probe: 0 });
assert.strictEqual(s.qq.recentMinutes.length, 60);
assert.strictEqual(s.qq.recentMinutes[59], 5, 'newest minute is last');
assert.deepStrictEqual(s.netease.thisMinute, { read: 0, write: 0, lyric: 0, login: 0, probe: 0 }, 'other platform untouched');

// Next minute starts a new bucket; the hour and the day keep counting.
meter.record('qq', 'read', t0 + 60000);
s = meter.snapshot(t0 + 61000);
assert.deepStrictEqual(s.qq.thisMinute, { read: 1, write: 0, lyric: 0, login: 0, probe: 0 });
assert.strictEqual(s.qq.lastHour.read + s.qq.lastHour.write + s.qq.lastHour.lyric, 6);
assert.strictEqual(s.qq.today.read, 4);

// Yesterday is kept, the day before is not.
meter.record('netease', 'read', t0 - 86400000);
meter.record('netease', 'read', t0 - 2 * 86400000);
s = meter.snapshot(t0);
assert.strictEqual(s.netease.yesterday.read, 1);
assert.strictEqual(s.netease.today.read, 0);

// The warning fires once per minute on crossing the threshold, not per call.
const warns = [];
const orig = console.warn;
console.warn = (m) => warns.push(String(m));
try {
  meter.reset();
  const t1 = Date.UTC(2026, 8, 27, 13, 0, 0);
  for (let i = 0; i <= meter.THRESHOLDS.netease.minute + 5; i += 1) meter.record('netease', 'read', t1 + i * 10);
  assert.strictEqual(warns.length, 1, 'one warning for the minute');
  assert.ok(/\[outbound\] netease 10[1-9] calls this minute/.test(warns[0]), warns[0]);
  meter.record('netease', 'read', t1 + 60000 * 2);
  assert.strictEqual(warns.length, 1, 'a quiet minute does not warn');
} finally {
  console.warn = orig;
}

// Old minutes are swept; the window stays bounded.
meter.reset();
const t2 = Date.UTC(2026, 8, 27, 14, 0, 0);
for (let i = 0; i < 200; i += 1) meter.record('qq', 'read', t2 + i * 60000);
s = meter.snapshot(t2 + 199 * 60000);
assert.strictEqual(s.qq.recentMinutes.filter(Boolean).length, 60, 'exactly the last hour is kept');

// login and probe are their own kinds, count toward the total and the hour.
meter.reset();
const t3 = Date.UTC(2026, 8, 30, 8, 0, 0);
meter.record('qq', 'login', t3);
meter.record('netease', 'probe', t3);
meter.record('netease', 'read', t3);
s = meter.snapshot(t3 + 1000);
assert.strictEqual(s.qq.thisMinute.login, 1);
assert.strictEqual(s.qq.lastHour.login, 1);
assert.strictEqual(s.netease.today.probe, 1);
assert.strictEqual(s.netease.recentMinutes[59], 2, 'probe counts in the minute total');

// Calls from users' own browsers are kept apart from the server's.
meter.recordUserIp('qq', 3, t3);
meter.recordUserIp('qq', 2, t3 + 60000);
meter.recordUserIp('qq', 99999, t3 + 60000); // capped per report
meter.recordUserIp('qq', -5, t3); // ignored
meter.recordUserIp('bogus', 5, t3); // unknown platform ignored
let u = meter.userIpSnapshot(t3 + 61000);
assert.strictEqual(u.qq.thisMinute, 202);
assert.strictEqual(u.qq.lastHour, 205);
assert.strictEqual(u.qq.today, 205);
assert.strictEqual(u.netease.today, 0);
assert.strictEqual(meter.snapshot(t3 + 61000).qq.today.read, 0, 'user-IP calls never enter the server count');
assert.ok(!('bogus' in u));

console.log('outbound-meter tests passed');
