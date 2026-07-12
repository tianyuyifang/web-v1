const assert = require('assert');
const { normalizeSessions, addSession, hasSession } = require('../src/utils/sessions');

// normalize tolerates junk
assert.deepStrictEqual(normalizeSessions(null), []);
assert.deepStrictEqual(normalizeSessions('x'), []);
assert.deepStrictEqual(
  normalizeSessions([{ sid: 'a', createdAt: '2020' }, { bad: 1 }]),
  [{ sid: 'a', createdAt: '2020' }]
);

// add under limit keeps all
let l = addSession([], 's1', '2026-01-01T00:00:00.000Z', 2);
l = addSession(l, 's2', '2026-01-02T00:00:00.000Z', 2);
assert.strictEqual(l.length, 2);
assert.ok(hasSession(l, 's1') && hasSession(l, 's2'));

// add over limit evicts oldest
l = addSession(l, 's3', '2026-01-03T00:00:00.000Z', 2);
assert.strictEqual(l.length, 2);
assert.ok(!hasSession(l, 's1'), 'oldest s1 evicted');
assert.ok(hasSession(l, 's2') && hasSession(l, 's3'));

// limit 1 behaves like today
let one = addSession([], 'a', '2026-01-01T00:00:00.000Z', 1);
one = addSession(one, 'b', '2026-01-02T00:00:00.000Z', 1);
assert.deepStrictEqual(one.map((e) => e.sid), ['b']);

// Infinity never trims
let inf = [];
for (let i = 0; i < 5; i++) {
  inf = addSession(inf, 's' + i, '2026-01-0' + (i + 1) + 'T00:00:00.000Z', Infinity);
}
assert.strictEqual(inf.length, 5);

console.log('sessions.test OK');
