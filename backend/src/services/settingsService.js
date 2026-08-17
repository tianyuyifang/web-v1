const prisma = require('../db/client');
const { ValidationError } = require('../utils/errors');

/**
 * The signup promotion: while it runs, registering makes you a MEMBER instead
 * of a GUEST.
 *
 * Two ways to say how long the free membership lasts, because both come up:
 *   - grantDays: N     → each signup gets N days from the day they register
 *   - grantUntil: date → every signup expires on the same day
 * Exactly one of the two is set.
 *
 * `endsAt` is when the promotion stops applying to new signups. It is separate
 * from how long the membership lasts: a campaign that runs a week can still
 * hand out a month. It is also what makes this safe to forget about — the
 * promotion lapses on its own rather than running until someone remembers.
 */
const PROMO_KEY = 'signupPromo';

const PROMO_OFF = Object.freeze({
  enabled: false,
  endsAt: null,
  grantDays: null,
  grantUntil: null,
  note: null,
});

/** Reads a setting, returning the fallback when the row is absent. */
async function get(key, fallback) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? row.value : fallback;
}

async function set(key, value) {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  return value;
}

/** The stored promotion, exactly as configured — expired or not. */
async function getSignupPromo() {
  const raw = await get(PROMO_KEY, PROMO_OFF);
  return { ...PROMO_OFF, ...raw };
}

/**
 * Whether the promotion applies right now, and what it grants.
 *
 * A promotion past its end date reports inactive without being rewritten:
 * turning it off in the database would need a write on a read path, and would
 * erase what the campaign was when the admin comes to look at it.
 *
 * @returns {Promise<{active: boolean, expiresAt: Date|null}>} expiresAt is the
 *   membership expiry to stamp on the new user, or null for no expiry.
 */
async function resolveSignupPromo(now = new Date()) {
  const promo = await getSignupPromo();
  if (!promo.enabled) return { active: false, expiresAt: null };
  if (promo.endsAt && new Date(promo.endsAt) <= now) {
    return { active: false, expiresAt: null };
  }

  if (promo.grantUntil) {
    const until = new Date(promo.grantUntil);
    // A shared end date that has already passed would hand out a membership
    // that is expired on arrival — worse than not running the promotion.
    if (until <= now) return { active: false, expiresAt: null };
    return { active: true, expiresAt: until };
  }

  if (promo.grantDays) {
    const until = new Date(now);
    until.setDate(until.getDate() + promo.grantDays);
    return { active: true, expiresAt: until };
  }

  // Enabled with neither field set: membership with no expiry. Allowed, but it
  // has to be chosen deliberately in the admin form.
  return { active: true, expiresAt: null };
}

/** Validates and stores the promotion. Admin-supplied input. */
async function setSignupPromo(input) {
  const enabled = Boolean(input.enabled);

  if (!enabled) {
    // Keep the dates so re-enabling shows what was there last time.
    return set(PROMO_KEY, { ...(await getSignupPromo()), enabled: false });
  }

  const grantDays = input.grantDays == null || input.grantDays === ''
    ? null
    : Number(input.grantDays);
  const grantUntil = input.grantUntil ? new Date(input.grantUntil) : null;
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;

  if (grantDays != null && grantUntil) {
    throw new ValidationError('Set either a number of days or an end date, not both');
  }
  if (grantDays != null && (!Number.isInteger(grantDays) || grantDays < 1 || grantDays > 3650)) {
    throw new ValidationError('Days must be a whole number between 1 and 3650');
  }
  if (grantUntil && Number.isNaN(grantUntil.getTime())) {
    throw new ValidationError('Invalid membership end date');
  }
  if (endsAt && Number.isNaN(endsAt.getTime())) {
    throw new ValidationError('Invalid promotion end date');
  }
  // A promotion whose window has already closed would save as permanently
  // inactive, which reads as "it silently did not work".
  if (endsAt && endsAt <= new Date()) {
    throw new ValidationError('The promotion end date is already in the past');
  }

  return set(PROMO_KEY, {
    enabled: true,
    endsAt: endsAt ? endsAt.toISOString() : null,
    grantDays,
    grantUntil: grantUntil ? grantUntil.toISOString() : null,
    note: input.note ? String(input.note).slice(0, 200) : null,
  });
}

module.exports = {
  PROMO_KEY,
  getSignupPromo,
  resolveSignupPromo,
  setSignupPromo,
};
