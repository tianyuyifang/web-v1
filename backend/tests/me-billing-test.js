const assert = require('assert');
const prisma = require('../src/db/client');
const { getMe } = require('../src/services/authService');

(async () => {
  // Create a temp user with an expired subscription and a fee
  const u = await prisma.user.create({
    data: {
      username: '__billing_test_' + Date.now(),
      passwordHash: 'x',
      role: 'MEMBER',
      expiresAt: new Date('2020-01-01T00:00:00Z'),
      monthlyFee: '29.90',
      paymentStatus: 'PAID',
      billingNotes: 'secret note',
    },
  });

  const me = await getMe(u.id);
  assert.strictEqual(me.status, 'expired', 'past expiry -> expired');
  assert.strictEqual(Number(me.monthlyFee), 29.9, 'fee returned as number');
  assert.ok(me.expiresAt, 'expiresAt present');
  assert.strictEqual(me.billingNotes, undefined, 'billingNotes must NOT be exposed');
  assert.strictEqual(me.paymentStatus, undefined, 'paymentStatus must NOT be exposed');

  await prisma.user.delete({ where: { id: u.id } });
  console.log('me-billing-test: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
