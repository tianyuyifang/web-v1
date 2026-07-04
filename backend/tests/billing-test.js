const assert = require('assert');
const { deriveStatus, addOneMonth } = require('../src/utils/billing');

// deriveStatus
assert.strictEqual(deriveStatus(null), 'active', 'null expiry = active');
const past = new Date('2020-01-01T00:00:00Z');
const future = new Date('2999-01-01T00:00:00Z');
assert.strictEqual(deriveStatus(past), 'expired', 'past = expired');
assert.strictEqual(deriveStatus(future), 'active', 'future = active');

// addOneMonth — normal
const feb = addOneMonth(new Date('2026-01-15T00:00:00Z'));
assert.strictEqual(feb.toISOString().slice(0, 10), '2026-02-15', 'Jan 15 -> Feb 15');

// addOneMonth — end-of-month clamp (Jan 31 -> Feb 28 in 2026, non-leap)
const clamp = addOneMonth(new Date('2026-01-31T00:00:00Z'));
assert.strictEqual(clamp.toISOString().slice(0, 10), '2026-02-28', 'Jan 31 -> Feb 28');

// addOneMonth — leap year (Jan 31 2028 -> Feb 29)
const leap = addOneMonth(new Date('2028-01-31T00:00:00Z'));
assert.strictEqual(leap.toISOString().slice(0, 10), '2028-02-29', 'Jan 31 2028 -> Feb 29');

console.log('billing-test: all assertions passed');
