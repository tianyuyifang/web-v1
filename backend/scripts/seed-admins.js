/**
 * seed-admins.js
 *
 * Creates (or updates) the two admin accounts defined in .env.
 * Safe to re-run — uses upsert so existing accounts are not duplicated.
 *
 * Usage: node scripts/seed-admins.js
 *
 * Required env vars:
 *   ADMIN_1_USERNAME, ADMIN_1_PASSWORD
 *   ADMIN_2_USERNAME, ADMIN_2_PASSWORD
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/db/client');

const SALT_ROUNDS = 10;

async function seedAdmin(username, password) {
  if (!username || !password) {
    console.error(`  Skipping: missing username or password`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.upsert({
    where: { username },
    update: { passwordHash, role: 'ADMIN' },
    create: { username, passwordHash, role: 'ADMIN' },
    select: { id: true, username: true, role: true },
  });

  console.log(`  ✓ ${user.username} (${user.role}) — ${user.id}`);
}

async function main() {
  console.log('Seeding admin accounts...');

  await seedAdmin(process.env.ADMIN_1_USERNAME, process.env.ADMIN_1_PASSWORD);
  await seedAdmin(process.env.ADMIN_2_USERNAME, process.env.ADMIN_2_PASSWORD);
  await seedAdmin(process.env.ADMIN_3_USERNAME, process.env.ADMIN_3_PASSWORD);

  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
