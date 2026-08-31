/**
 * One-time backfill: put existing members on a tier that reproduces what they
 * have today, so switching to tier-driven permissions changes nobody's access.
 *
 * The rule, matching how accounts were actually set up:
 *   - Everyone with the capture add-on today  → VIP  (VIP grants 加订)
 *   - Everyone without it                      → 普通 (normal grants nothing)
 *   - ADMIN                                     → left alone (holds everything
 *     regardless of tier)
 *
 * Per-user overrides are preserved as overrides:
 *   - entitlements is CLEARED for the tiered members — the tier now grants
 *     capture, so keeping the string would be a redundant override that pins
 *     them even if you later change what VIP means. (A member you WANT pinned
 *     regardless of tier keeps theirs; none exist today beyond the tier grant.)
 *   - deviceLimit is LEFT untouched — the 19 members with a hand-set limit keep
 *     it as their override, exactly the "friend with extra devices, still in
 *     their tier" case the feature is for.
 *
 * Dry by default; --apply to write. Idempotent: re-running only moves rows that
 * are not already where the rule puts them.
 *
 *   node scripts/backfill-tiers.js            # show what would change
 *   node scripts/backfill-tiers.js --apply
 */
require('dotenv').config();
const prisma = require('../src/db/client');

const APPLY = process.argv.includes('--apply');

(async () => {
  const members = await prisma.user.findMany({
    where: { role: { in: ['MEMBER', 'GUEST'] } },
    select: { id: true, username: true, role: true, entitlements: true, tier: true, deviceLimit: true },
  });

  let toVip = 0;
  let toNormal = 0;
  let unchanged = 0;
  const ops = [];

  for (const u of members) {
    const hasCapture = Array.isArray(u.entitlements) && u.entitlements.includes('capture');
    const wantTier = hasCapture ? 'vip' : 'normal';
    // Clear the capture override once the tier carries it; keep any other
    // string (there are none today, but do not assume).
    const wantEntitlements = hasCapture
      ? u.entitlements.filter((e) => e !== 'capture')
      : u.entitlements;

    const tierChanges = u.tier !== wantTier;
    const entChanges = JSON.stringify(u.entitlements) !== JSON.stringify(wantEntitlements);
    if (!tierChanges && !entChanges) { unchanged++; continue; }

    if (wantTier === 'vip') toVip++; else toNormal++;
    ops.push({ id: u.id, username: u.username, wantTier, wantEntitlements, keepDevice: u.deviceLimit });
  }

  console.log(`members: ${members.length}`);
  console.log(`  → VIP:    ${toVip}`);
  console.log(`  → 普通:   ${toNormal}`);
  console.log(`  unchanged: ${unchanged}`);
  const withDevice = members.filter((u) => u.deviceLimit != null).length;
  console.log(`  keeping a per-user device override: ${withDevice}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    await prisma.$disconnect();
    return;
  }

  for (const op of ops) {
    await prisma.user.update({
      where: { id: op.id },
      data: { tier: op.wantTier, entitlements: op.wantEntitlements },
    });
  }
  console.log(`\napplied to ${ops.length} members. deviceLimit left untouched throughout.`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
