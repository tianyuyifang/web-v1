const assert = require('assert');
const bcrypt = require('bcryptjs');
const prisma = require('../src/db/client');
const { resetPassword, generateTempPassword } = require('../src/services/adminService');

(async () => {
  // generateTempPassword: right length, only unambiguous chars, varies
  const a = generateTempPassword();
  const b = generateTempPassword();
  assert.strictEqual(a.length, 12, 'temp pw length 12');
  assert.ok(/^[A-HJ-NP-Za-km-z2-9]+$/.test(a), 'temp pw uses unambiguous alphabet (no 0/O/1/l/I)');
  assert.notStrictEqual(a, b, 'temp pw varies between calls');

  // Create a MEMBER with a known password.
  const OLD = 'oldPassword123';
  const oldHash = await bcrypt.hash(OLD, 10);
  const u = await prisma.user.create({
    data: { username: '__reset_pw_' + Date.now(), passwordHash: oldHash, role: 'MEMBER' },
  });

  const res = await resetPassword(u.id);
  assert.strictEqual(res.id, u.id, 'returns user id');
  assert.ok(res.username === u.username, 'returns username');
  assert.ok(typeof res.tempPassword === 'string' && res.tempPassword.length === 12, 'returns temp password');

  // The stored hash now verifies against the temp password, and NOT the old one.
  const after = await prisma.user.findUnique({ where: { id: u.id }, select: { passwordHash: true } });
  assert.ok(await bcrypt.compare(res.tempPassword, after.passwordHash), 'new hash verifies temp password');
  assert.ok(!(await bcrypt.compare(OLD, after.passwordHash)), 'old password no longer works');
  assert.notStrictEqual(after.passwordHash, res.tempPassword, 'password is stored hashed, not plaintext');

  // Admins cannot be reset.
  const admin = await prisma.user.create({
    data: { username: '__reset_pw_admin_' + Date.now(), passwordHash: oldHash, role: 'ADMIN' },
  });
  let threw = false;
  try { await resetPassword(admin.id); } catch (e) { threw = true; assert.strictEqual(e.statusCode, 403, 'admin reset throws 403 Forbidden'); }
  assert.ok(threw, 'resetPassword on ADMIN throws');
  // admin hash untouched
  const adminAfter = await prisma.user.findUnique({ where: { id: admin.id }, select: { passwordHash: true } });
  assert.strictEqual(adminAfter.passwordHash, oldHash, 'admin password unchanged');

  // Non-existent user -> NotFoundError
  let threw404 = false;
  try { await resetPassword('00000000-0000-0000-0000-000000000000'); }
  catch (e) { threw404 = true; assert.strictEqual(e.statusCode, 404, 'missing user throws 404 NotFound'); }
  assert.ok(threw404, 'resetPassword on missing user throws');

  await prisma.user.delete({ where: { id: u.id } });
  await prisma.user.delete({ where: { id: admin.id } });
  console.log('admin-reset-password-test: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
