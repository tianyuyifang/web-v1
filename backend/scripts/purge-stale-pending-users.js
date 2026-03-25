/**
 * purge-stale-pending.js
 *
 * Finds all PENDING users whose accounts are older than PENDING_THRESHOLD_MONTHS
 * and permanently deletes them along with all their associated data (playlists,
 * clips, likes, shares, copy permissions — cascaded by the DB schema).
 *
 * Usage: node scripts/purge-stale-pending.js [--dry-run]
 *
 * Options:
 *   --dry-run   Print which users would be deleted without actually deleting.
 */

require('dotenv').config();
const prisma = require('../src/db/client');

const PENDING_THRESHOLD_MONTHS = 6;
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - PENDING_THRESHOLD_MONTHS);

  const staleUsers = await prisma.user.findMany({
    where: {
      role: 'PENDING',
      createdAt: { lt: cutoff },
    },
    select: { id: true, username: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (staleUsers.length === 0) {
    console.log(`No PENDING users older than ${PENDING_THRESHOLD_MONTHS} months found.`);
    return;
  }

  console.log(`Found ${staleUsers.length} stale PENDING user(s) (created before ${cutoff.toISOString()}):`);
  staleUsers.forEach(u => console.log(`  ${u.username} | created ${u.createdAt.toISOString()}`));

  if (DRY_RUN) {
    console.log('\nDry run — no data deleted.');
    return;
  }

  const ids = staleUsers.map(u => u.id);
  const result = await prisma.user.deleteMany({ where: { id: { in: ids } } });

  console.log(`\nDeleted ${result.count} user(s) and all their associated data.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
