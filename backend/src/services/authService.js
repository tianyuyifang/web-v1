const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const prisma = require('../db/client');
const { UnauthorizedError, ValidationError } = require('../utils/errors');
const { deriveStatus } = require('../utils/billing');
const { normalizeSessions, addSession, hasSession } = require('../utils/sessions');
const { resolveSignupPromo, getTiers } = require('./settingsService');
const { ADD_ONS, hasAddOn } = require('../utils/entitlements');
const CAPTURE = ADD_ONS.CAPTURE;

const SALT_ROUNDS = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user, sessionId) {
  const payload = { sub: user.id, username: user.username, role: user.role };
  if (sessionId) payload.sid = sessionId;
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

async function register({ username, password }) {
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    const err = new ValidationError({ username: ['Username already exists'] });
    err.message = 'Username already exists';
    throw err;
  }

  const passwordHash = await hashPassword(password);

  // Signing up lands you in as a GUEST rather than queued for approval. Stated
  // outright instead of leaning on the schema default, which is still PENDING
  // — that is now where expired accounts land, not where new ones start.
  //
  // …unless a signup promotion is running, which makes new accounts MEMBER on
  // the VIP tier with an expiry, the same shape an admin-approved member has.
  // If reading the promotion fails, registration still succeeds but the
  // account waits for approval (promo-off behaviour): a broken campaign should
  // not stop people signing up, nor let them straight in.
  let promo = { active: false, expiresAt: null };
  try {
    promo = await resolveSignupPromo();
  } catch (err) {
    // A failed lookup is treated as promo-off: the safe default is to make the
    // account wait for approval, not to let it straight in.
    console.error('Signup promo lookup failed, defaulting to approval-gated:', err.message);
  }

  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
      /**
       * Promotion decides whether a new account walks in or waits.
       *
       *   promo on  → MEMBER on the VIP tier, live immediately with 唱卡. The
       *     tier grants the add-on, so nothing is stuffed into entitlements —
       *     permissions come from one place now.
       *   promo off → PENDING. The account cannot log in until an admin
       *     approves it, which is where GUEST used to sit; there is no reason
       *     to mint a half-limited guest role for that any more, and approval
       *     puts them on VIP too (see approveUser).
       */
      role: promo.active ? 'MEMBER' : 'PENDING',
      tier: promo.active ? 'vip' : null,
      expiresAt: promo.active ? promo.expiresAt : null,
    },
    select: { id: true, username: true, role: true, preferences: true },
  });

  return { user };
}

async function login({ username, password }) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new UnauthorizedError('Invalid username or password');

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid username or password');

  const sessionId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  // Row-locked read-modify-write on the active-sessions list, so two logins
  // racing on the same account can't clobber each other's array. Evicts the
  // oldest device when the new login would exceed the user's device limit.
  // ADMIN is unrestricted (Infinity => no trimming).
  // Read once, outside the lock: the tier config is a settings row, not part
  // of the per-user race the transaction guards.
  const tiers = await getTiers();
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT active_sessions, role, device_limit, tier
      FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
    const locked = rows[0];
    // Fall back to 1 if the global default is missing/invalid, so a config gap
    // can never silently grant unlimited devices to default users.
    const globalDefault = Number.isInteger(config.defaultDeviceLimit) && config.defaultDeviceLimit >= 1
      ? config.defaultDeviceLimit
      : 1;
    // Three tiers of answer, narrowest first: a per-user override wins, else
    // the membership tier's current device limit, else the global default.
    // The override is what lets an admin lift one friend above their tier
    // without moving them out of it.
    const tierLimit = locked.tier && tiers[locked.tier]
      ? tiers[locked.tier].deviceLimit : null;
    const limit = locked.role === 'ADMIN'
      ? Infinity
      : (locked.device_limit != null ? locked.device_limit
        : (tierLimit != null ? tierLimit : globalDefault));
    const list = addSession(normalizeSessions(locked.active_sessions), sessionId, nowIso, limit);
    return tx.user.update({
      where: { id: user.id },
      data: { activeSessions: list, activeSessionId: sessionId },
      select: {
        id: true, username: true, role: true, preferences: true,
        previousRole: true,
      },
    });
  });

  const token = signToken(updated, sessionId);
  return {
    token,
    user: {
      id: updated.id,
      username: updated.username,
      role: updated.role,
      preferences: updated.preferences,
      // A disabled account is told why at the login screen, and that depends
      // on what it was before.
      previousRole: updated.previousRole,
    },
  };
}

async function changeUsername(userId, { newUsername, currentPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedError('User not found');

  const valid = await comparePassword(currentPassword, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Current password is incorrect');

  const existing = await prisma.user.findUnique({ where: { username: newUsername } });
  if (existing) {
    const err = new ValidationError({ newUsername: ['Username already exists'] });
    err.message = 'Username already exists';
    throw err;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { username: newUsername },
    select: { id: true, username: true, role: true, preferences: true },
  });
  return updated;
}

async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedError('User not found');

  const valid = await comparePassword(currentPassword, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Current password is incorrect');

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}

async function getMe(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, username: true, role: true, preferences: true,
      expiresAt: true, monthlyFee: true, previousRole: true,
      entitlements: true, tier: true,
      canEditMapping: true,
    },
  });
  if (!user) return null;
  // The EFFECTIVE add-ons, resolving the tier and the per-user override the
  // same way the server gate does, so the page's canCapture stays a plain
  // membership check without needing to know about tiers. A tier that grants
  // 加订 adds 'capture'; a hand-set override list still wins on its own.
  const tiers = await getTiers();
  const effectiveEntitlements = hasAddOn(user, CAPTURE, tiers)
    ? Array.from(new Set([...(user.entitlements || []), CAPTURE]))
    : (user.entitlements || []);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    preferences: user.preferences,
    expiresAt: user.expiresAt,
    monthlyFee: user.monthlyFee == null ? null : Number(user.monthlyFee),
    // Lets the disabled-account page say why: an expired guest and a lapsed
    // member both sit in PENDING but need different wording.
    previousRole: user.previousRole,
    // Effective add-ons: the per-user override merged with whatever the tier
    // grants, so the page reads one list and never has to know about tiers.
    entitlements: effectiveEntitlements,
    // The tier itself, for the account page to show which one they hold.
    tier: user.tier || null,
    // Whether this account may decide song mappings. Sent so the pages that
    // offer those decisions can leave them out rather than show buttons that
    // fail: 唱卡 is open to every add-on holder, but only editors confirm a
    // version or remove one. The server checks it again on every write —
    // this only spares the user a button that was never going to work.
    canEditMapping: !!user.canEditMapping,
    status: deriveStatus(user.expiresAt),
  };
}

async function updatePreferences(userId, preferences) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { preferences },
    select: { id: true, username: true, role: true, preferences: true },
  });
  return user;
}

/**
 * Refresh a JWT token. Accepts tokens that are still valid or expired by up to 24 hours.
 * Verifies the user still exists and is still MEMBER/ADMIN.
 * Returns a fresh token with a new 7-day expiry.
 */
async function refreshToken(req) {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new UnauthorizedError('Missing token');

  let payload;
  try {
    // First try normal verification (token not expired)
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      // Allow tokens expired by up to 24 hours — gives users a grace window
      // to refresh even if they come back slightly after expiry
      payload = jwt.verify(token, config.jwtSecret, { ignoreExpiration: true });
      const expiredAt = payload.exp * 1000;
      const gracePeriod = 24 * 60 * 60 * 1000; // 24 hours
      if (Date.now() - expiredAt > gracePeriod) {
        throw new UnauthorizedError('Token expired too long ago');
      }
    } else {
      throw new UnauthorizedError('Invalid token');
    }
  }

  // Verify user still exists and is active
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, username: true, role: true, activeSessionId: true, activeSessions: true },
  });
  if (!user) throw new UnauthorizedError('User not found');
  if (user.role === 'PENDING') throw new UnauthorizedError('Account not approved');

  // Check the token's session is still one of the active devices. ADMIN is
  // unrestricted. If the user has no recorded sessions (pre-migration), skip.
  // Refresh NEVER mutates the session list — only login does — so two tabs
  // refreshing simultaneously can't evict each other.
  if (user.role !== 'ADMIN' && payload.sid) {
    const list = normalizeSessions(user.activeSessions);
    if (list.length > 0 && !hasSession(list, payload.sid)) {
      const err = new Error('Your account was logged in on another device');
      err.status = 403;
      err.code = 'SESSION_REPLACED';
      throw err;
    }
  }

  // Reuse the same sessionId — only login generates a new one.
  // Use existing sid if available; omit from JWT if neither exists (pre-migration)
  const sid = payload.sid || user.activeSessionId || undefined;
  const newToken = signToken(user, sid);
  return { token: newToken };
}

module.exports = { register, login, getMe, changePassword, changeUsername, updatePreferences, refreshToken };
