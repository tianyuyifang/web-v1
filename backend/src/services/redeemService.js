const crypto = require('crypto');
const prisma = require('../db/client');
const { addDays, addMonths, deriveStatus } = require('../utils/billing');
const { invalidateSessionCache } = require('../middleware/auth');
const { TIER_KEYS, TIER_LABELS } = require('./settingsService');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors');

// Confusion-free alphabet (no 0/O/1/I/L) — the code is copied by hand off a
// receipt and typed on a phone, where a misread character is a failed redeem
// with no obvious cause. Same reasoning as the capture pair code.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// Four groups of four, dash-separated: QNI-3F9K-2XQ7-M4RT — readable, and long
// enough (16 chars of ~31 alphabet ≈ 79 bits) that guessing is hopeless even
// before the redeem rate limit.
const CODE_GROUPS = 4;
const CODE_GROUP_LEN = 4;

function generateCodeString() {
  const groups = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    const bytes = crypto.randomBytes(CODE_GROUP_LEN);
    let s = '';
    for (let i = 0; i < CODE_GROUP_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    groups.push(s);
  }
  return `QNI-${groups.join('-')}`;
}

// The presets the admin panel offers, plus arbitrary days. A preset is stored
// as (days, months) so "1 month"/"1 quarter" track the calendar via addMonths
// while day/week are plain days. Exactly one field is non-zero per preset.
const PRESETS = {
  day:     { durationDays: 1,  durationMonths: 0, label: '1 天' },
  week:    { durationDays: 7,  durationMonths: 0, label: '1 周' },
  month:   { durationDays: 0,  durationMonths: 1, label: '1 个月' },
  quarter: { durationDays: 0,  durationMonths: 3, label: '1 季度' },
};

/**
 * Generate `count` codes of one duration. Duration is either a preset key or
 * an arbitrary number of days. Returns the created rows (code strings included,
 * since the whole point is to hand them to buyers).
 *
 * @param {object} opts
 * @param {string} [opts.preset]  - one of PRESETS keys
 * @param {number} [opts.days]    - arbitrary day count (used when no preset)
 * @param {number} opts.count     - how many codes to make (1..500)
 * @param {string} opts.adminId   - who generated them
 */
async function generateCodes({ preset, days, count, tier, adminId }) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new ValidationError({ count: ['数量必须是 1 到 500 的整数'] });
  }

  // Every code carries the tier it grants — a redeem is "buy this tier for this
  // long". Validated against the live tier keys.
  if (!TIER_KEYS.includes(tier)) {
    throw new ValidationError({ tier: ['请选择档位'] });
  }
  const tierLabel = TIER_LABELS[tier] || tier;

  let durationDays = 0;
  let durationMonths = 0;
  let durationLabel = null;
  if (preset) {
    const p = PRESETS[preset];
    if (!p) throw new ValidationError({ preset: ['未知的时长档位'] });
    ({ durationDays, durationMonths } = p);
    durationLabel = p.label;
  } else {
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 3650) {
      throw new ValidationError({ days: ['天数必须是 1 到 3650 的整数'] });
    }
    durationDays = d;
    durationLabel = `${d} 天`;
  }
  // Label the admin list sees: "超级VIP · 1 个月".
  const label = `${tierLabel} · ${durationLabel}`;

  // Generate, insert, and on the astronomically-rare unique collision retry
  // that one code. createMany would fail the whole batch on a single dup, so
  // insert one at a time — count is capped at 500, so this is cheap.
  const created = [];
  for (let i = 0; i < n; i++) {
    let row = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      try {
        row = await prisma.activationCode.create({
          data: {
            code: generateCodeString(),
            durationDays,
            durationMonths,
            tier,
            label,
            createdBy: adminId || null,
          },
        });
      } catch (err) {
        if (err.code === 'P2002') continue; // code collision — try a new one
        throw err;
      }
    }
    if (!row) throw new Error('Could not generate a unique code after retries');
    created.push(row);
  }
  return created;
}

/** Admin list of all codes, newest first. Plaintext code included. */
async function listCodes({ take = 200 } = {}) {
  return prisma.activationCode.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(take) || 200, 1000),
  });
}

/** Void an unused code so it can never be redeemed. No-op if already used. */
async function voidCode(id) {
  const row = await prisma.activationCode.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Activation code');
  if (row.usedAt) throw new ValidationError({ code: ['该码已被使用，无法作废'] });
  return prisma.activationCode.update({
    where: { id },
    data: { voidedAt: new Date() },
    select: { id: true, code: true, voidedAt: true },
  });
}

/**
 * Redeem a code onto an account, atomically.
 *
 * Public: a PENDING/expired user has no token, so they identify by username +
 * code. The code and the account move together in one transaction under a row
 * lock, so a code can never be spent twice and two concurrent redeems of the
 * same code can't both win.
 *
 * Renewal rule (per product decision): expiresAt = now + duration, from the
 * moment of activation (not stacked onto a remaining future date — these codes
 * are for lapsed/expired accounts). role is restored to MEMBER and the demotion
 * trail cleared, mirroring approveUser, so a revoked (PENDING) account comes
 * fully back. A tier is defaulted only when absent, like approveUser.
 *
 * @param {string} username
 * @param {string} code
 */
async function redeem(username, code) {
  const uname = String(username || '').trim();
  const ccode = String(code || '').trim().toUpperCase();
  if (!uname || !ccode) {
    throw new ValidationError({ code: ['请输入用户名和激活码'] });
  }

  const user = await prisma.user.findUnique({ where: { username: uname } });
  // Same opaque message for "no such user" and "bad code" would be friendlier
  // to privacy, but the two need different fixes and neither is a secret here
  // (an admin gives out both). Be specific so a mistyped username is obvious.
  if (!user) {
    const err = new NotFoundError('User');
    err.code = 'NO_USER';
    err.message = '找不到该用户名';
    throw err;
  }
  if (user.role === 'ADMIN') {
    const err = new ForbiddenError('管理员账号无需激活');
    err.code = 'ADMIN_ACCOUNT';
    throw err;
  }
  // Codes are for lapsed/PENDING accounts only. A still-active MEMBER redeeming
  // would OVERWRITE their expiresAt with now+duration and lose remaining time
  // (redeem sets, it doesn't stack — the product decision). Refuse it so a code
  // is never wasted; PENDING always passes (that IS the case codes exist for),
  // and an expired MEMBER (deriveStatus 'expired') passes too. Only a MEMBER
  // still within paid time is turned away.
  if (user.role === 'MEMBER' && deriveStatus(user.expiresAt) === 'active') {
    const err = new ForbiddenError('账号仍在有效期内，无需激活');
    err.code = 'STILL_ACTIVE';
    throw err;
  }

  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // Lock the code row so a concurrent redeem of the same code blocks here and
    // then sees used_at set. Raw SQL because Prisma has no FOR UPDATE.
    const rows = await tx.$queryRaw`
      SELECT id, duration_days, duration_months, tier, used_at, voided_at
      FROM activation_codes WHERE code = ${ccode} FOR UPDATE`;
    const c = rows[0];
    if (!c) {
      const err = new NotFoundError('Activation code');
      err.code = 'INVALID_CODE';
      err.message = '激活码无效';
      throw err;
    }
    if (c.voided_at) {
      const err = new ValidationError({ code: ['该激活码已作废'] });
      err.code = 'INVALID_CODE';
      throw err;
    }
    if (c.used_at) {
      const err = new ValidationError({ code: ['该激活码已被使用'] });
      err.code = 'CODE_USED';
      throw err;
    }

    // expiresAt = now + duration (days then months; one of them is 0).
    const expiresAt = addMonths(addDays(now, c.duration_days), c.duration_months);

    // Stamp the code used, in the same tx as the account update below.
    await tx.activationCode.update({
      where: { id: c.id },
      data: { usedAt: now, usedBy: user.id, usedByName: uname },
    });

    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        role: 'MEMBER',
        demotedAt: null,
        previousRole: null,
        expiresAt,
        // The code's tier is authoritative — buy the tier you pay for. It
        // overwrites the account's current tier (a lower-tier code does lower
        // the account; the device-limit change takes effect on next login, the
        // same as any tier change). A code without a tier (legacy/time-only)
        // falls back to the old rule: keep the tier, default vip if none.
        ...(c.tier ? { tier: c.tier } : (user.tier ? {} : { tier: 'vip' })),
      },
      select: { id: true, username: true, role: true, expiresAt: true, tier: true },
    });
    return updated;
  });

  // Outside the tx: the just-renewed account's cached role must clear so a
  // stale PENDING doesn't linger for the session-cache TTL.
  invalidateSessionCache(user.id);

  return { ok: true, username: result.username, expiresAt: result.expiresAt };
}

module.exports = { generateCodes, listCodes, voidCode, redeem, PRESETS };
