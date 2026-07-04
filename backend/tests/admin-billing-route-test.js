const assert = require('assert');
const { updateBillingSchema } = require('../src/validators/billing');

// Valid: partial patch with ISO date + string fee
const ok = updateBillingSchema.parse({ expiresAt: '2026-08-01T00:00:00.000Z', monthlyFee: '30.00', paymentStatus: 'PAID' });
assert.ok(ok.expiresAt instanceof Date, 'expiresAt transformed to Date');
assert.strictEqual(ok.monthlyFee, '30.00', 'fee kept as string');

// Valid: empty patch
assert.doesNotThrow(() => updateBillingSchema.parse({}), 'empty patch allowed');

// Valid: nulls clear fields
const cleared = updateBillingSchema.parse({ expiresAt: null, monthlyFee: null, billingNotes: null });
assert.strictEqual(cleared.expiresAt, null, 'null expiry allowed');

// Invalid: bad status
assert.throws(() => updateBillingSchema.parse({ paymentStatus: 'LATE' }), 'bad status rejected');
// Invalid: negative fee
assert.throws(() => updateBillingSchema.parse({ monthlyFee: -5 }), 'negative fee rejected');
// Invalid: 3-decimal fee string
assert.throws(() => updateBillingSchema.parse({ monthlyFee: '30.001' }), '3-decimal fee rejected');

console.log('admin-billing-route-test: all assertions passed');
