const assert = require('assert');
const prisma = require('../src/db/client');
const { updateBilling, extendOneMonth, listUsers } = require('../src/services/adminService');

(async () => {
  const u = await prisma.user.create({
    data: { username: '__admin_billing_' + Date.now(), passwordHash: 'x', role: 'MEMBER' },
  });

  // updateBilling sets fields
  const updated = await updateBilling(u.id, {
    monthlyFee: '30.00', paymentStatus: 'PAID', billingNotes: 'wechat',
    expiresAt: new Date('2026-08-01T00:00:00Z'),
  });
  assert.strictEqual(Number(updated.monthlyFee), 30, 'fee saved');
  assert.strictEqual(updated.paymentStatus, 'PAID', 'status saved');
  assert.strictEqual(updated.billingNotes, 'wechat', 'notes saved');

  // extendOneMonth from a future expiry -> +1 month from that expiry
  const ext = await extendOneMonth(u.id);
  assert.strictEqual(ext.expiresAt.toISOString().slice(0, 10), '2026-09-01', 'extend from future expiry');

  // extendOneMonth when expired -> ~1 month from today (just assert it is in the future)
  await updateBilling(u.id, { expiresAt: new Date('2020-01-01T00:00:00Z') });
  const ext2 = await extendOneMonth(u.id);
  assert.ok(ext2.expiresAt.getTime() > Date.now(), 'extend from past -> future date');

  // listUsers includes billing fields
  const all = await listUsers();
  const row = all.find((x) => x.id === u.id);
  assert.ok('paymentStatus' in row && 'expiresAt' in row, 'listUsers exposes billing fields');

  await prisma.user.delete({ where: { id: u.id } });
  console.log('admin-billing-test: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
