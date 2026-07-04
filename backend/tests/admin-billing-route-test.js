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
// Invalid: 3-decimal fee as a NUMBER (the actual gap — number branch had no decimal constraint)
assert.throws(() => updateBillingSchema.parse({ monthlyFee: 30.001 }), '3-decimal numeric fee rejected');

// Valid: whole-number numeric fee
const whole = updateBillingSchema.parse({ monthlyFee: 30 });
assert.strictEqual(whole.monthlyFee, '30', 'whole numeric fee normalized to string');

// Valid: numeric fee with 1 decimal
const oneDecimal = updateBillingSchema.parse({ monthlyFee: 30.5 });
assert.strictEqual(oneDecimal.monthlyFee, '30.5', 'one-decimal numeric fee normalized to string');

// Valid: string fee with trailing zero decimals
const stringWhole = updateBillingSchema.parse({ monthlyFee: '30.00' });
assert.strictEqual(stringWhole.monthlyFee, '30.00', 'two-decimal string fee kept as-is');

console.log('admin-billing-route-test: all assertions passed');
