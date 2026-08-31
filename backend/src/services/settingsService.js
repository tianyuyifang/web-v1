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

const CLIENT_VERSION_KEY = 'captureClientVersion';

/**
 * What the newest capture client is.
 *
 * Stored rather than hardcoded because it changes on a different clock from
 * the code: shipping an APK means uploading a file and saying so, and having
 * to edit a constant, commit, deploy and restart to finish that is a step easy
 * to forget. Forgetting it is silently wrong — every client then compares
 * itself against a stale number, decides it is current, and the update prompt
 * never appears for anyone.
 *
 * The fallback is the last value that was in the code, so a database with
 * nothing stored behaves exactly as before.
 */
// Latest shipped capture client. Bump minSupported when a change makes older
// clients wrong rather than merely outdated — a qni control-id change, say,
// where an old client silently captures nothing and the user assumes the tool
// is broken.
// v2 reworded the UI, v3 added the optional `side` field, v4 scans more often
// and sends a heartbeat, v5 starts its sweep from onCreate, v6 finds the
// candidate lists by id instead of walking the tree, v8 ties the client's
// "already sent" set to the token instead of the process, and v9 reports each
// title's row in the candidate list so the panel can line the two teams up the
// way qni does.
//
// v8 is the only release where an older client is actually wrong rather than
// merely limited: up to v7 that set was never cleared, so after switching
// playlists or re-pairing, every title captured under the previous token was
// skipped and the song silently never appeared. minSupported stays at 1 anyway
// — an old client still captures everything on a fresh pairing, and cutting
// users off mid-round is worse than the bug. The upgrade prompt covers it.
// A pre-v9 client simply sends no row and the panel falls back to independent
// columns.
// v10 only sends a row for titles actually inside a candidate list: screens
// without one returned 0 from getRowIndex() rather than -1, so nine unrelated
// titles claimed row 0 and the panel showed one of them. The panel no longer
// lets a repeated row overwrite anything either, so a v9 client is cosmetically
// off at worst.
// v17 reads the picking screen as one container again. Splitting it into two
// lookups doubled the calls per scan and then cost a tree climb per song to
// pair title with artist -- on an emulator, where a binder call is ~90x a
// handset's, that turned the fastest path in the client into one of the
// slowest. v16 added the artist pairing that v17 now gets for free.
// v15 sends the words the game shows while a song is sung, and says which
// screen each capture came from. Both were needed for the lyrics to survive at
// all: picking and singing show the same title, so the performance -- the only
// capture carrying lyrics -- was being discarded as a repeat.
// v14 reaches the 唱卡 views by their own ids: the container it had been
// asking for, singerDuelSingingAudienceHolder_cl_root, does not exist, so the
// singing screen always fell through to the tree walk and 两军对决 -- which
// alternates picking and singing every few seconds -- was never recognised. It
// also notices when an over-the-top install leaves the accessibility service
// switched on but no longer receiving events, which used to fail silently
// while the app reported itself healthy.
// v12 stops walking the whole tree on 歌 P screens. That walk never once
// produced a title (14 of 14 came from the team lists) but cost 2-12s on the
// main thread, blocking the events that arrived during it -- which is why tags
// used to appear in bursts after a stall. Worst-case scan went 17.4s -> 0.6s.
// v11 reads the delivery target off the heartbeat and scans only the round it
// names. Up to v10 every round's titles were read and sent regardless, so 唱卡
// songs were tagged into playlists during a 歌 P run -- 22 of 200 production
// captures. minSupported stays at 1: an older client is wrong only while both
// rounds are in play, and cutting users off mid-game is worse.
const CLIENT_VERSION_DEFAULT = Object.freeze({
  latest: 21,
  minSupported: 1,
  url: 'https://qnicheatsheet.com/qni-capture.apk',
  latestName: '3.0',
  releasedAt: '2026-08-22',
});

// --- Membership tiers ---------------------------------------------------
//
// A tier bundles the two things an admin used to set one user at a time: the
// add-on and the device limit. A member holds a tier, and their权限 are read
// from the tier's current values — change 挚友's device limit here and every
// 挚友 moves at once ("live tiers"), which is the whole point of the feature.
//
// The four keys are fixed (the ladder is a product decision, not data), but
// each tier's capture flag and device limit are editable from the admin page
// and stored under TIERS_KEY. A per-user override still wins over the tier —
// that lives on the user row (deviceLimit / entitlements), not here.
const TIERS_KEY = 'membershipTiers';
const TIER_KEYS = Object.freeze(['normal', 'vip', 'super_vip', 'zhiyou']);
const TIER_LABELS = Object.freeze({
  normal: '普通', vip: 'VIP', super_vip: '超级VIP', zhiyou: '挚友',
});
const TIERS_DEFAULT = Object.freeze({
  normal:    { capture: false, deviceLimit: 3 },
  vip:       { capture: true,  deviceLimit: 3 },
  super_vip: { capture: true,  deviceLimit: 5 },
  zhiyou:    { capture: true,  deviceLimit: 8 },
});

async function getTiers() {
  const raw = await get(TIERS_KEY, null);
  // Merge per-tier so a stored config missing a newly-added tier still fills
  // it from the default rather than returning undefined for it.
  const out = {};
  for (const k of TIER_KEYS) {
    out[k] = { ...TIERS_DEFAULT[k], ...((raw && raw[k]) || {}) };
  }
  return out;
}

/**
 * A patch keyed by tier, so setting one tier's device limit does not blank
 * the others. Each tier value is validated: capture is a boolean, deviceLimit
 * a positive integer, because these drive who can 唱卡 and how many devices
 * they may hold — a bad value would silently lock people out or open the door.
 */
async function setTiers(patch) {
  const current = await getTiers();
  const next = {};
  for (const k of TIER_KEYS) {
    const p = (patch && patch[k]) || {};
    const capture = p.capture !== undefined ? p.capture : current[k].capture;
    const deviceLimit = p.deviceLimit !== undefined ? p.deviceLimit : current[k].deviceLimit;
    if (typeof capture !== 'boolean') {
      throw new ValidationError({ [k]: ['加订必须是 true 或 false'] });
    }
    if (!Number.isInteger(deviceLimit) || deviceLimit < 1) {
      throw new ValidationError({ [k]: ['设备上限必须是正整数'] });
    }
    next[k] = { capture, deviceLimit };
  }
  await set(TIERS_KEY, next);
  return next;
}

async function getClientVersion() {
  const raw = await get(CLIENT_VERSION_KEY, null);
  return { ...CLIENT_VERSION_DEFAULT, ...(raw || {}) };
}

/**
 * A patch, so setting the version alone does not blank the download URL.
 *
 * `latest` is what every comparison runs on, so it is the one field checked
 * rather than trusted: a string or a decimal here would make every client
 * either permanently current or permanently outdated.
 */
async function setClientVersion(patch) {
  const current = await getClientVersion();
  const next = { ...current, ...(patch || {}) };

  if (!Number.isInteger(next.latest) || next.latest < 1) {
    throw new ValidationError({ latest: ['版本号必须是正整数'] });
  }
  if (!Number.isInteger(next.minSupported) || next.minSupported < 1) {
    throw new ValidationError({ minSupported: ['最低支持版本必须是正整数'] });
  }
  await set(CLIENT_VERSION_KEY, next);
  return next;
}

module.exports = {
  PROMO_KEY,
  CLIENT_VERSION_KEY,
  getClientVersion,
  setClientVersion,
  getSignupPromo,
  resolveSignupPromo,
  setSignupPromo,
  TIERS_KEY,
  TIER_KEYS,
  TIER_LABELS,
  TIERS_DEFAULT,
  getTiers,
  setTiers,
};
