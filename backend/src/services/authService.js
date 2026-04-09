const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const prisma = require('../db/client');
const { UnauthorizedError, ValidationError } = require('../utils/errors');

const SALT_ROUNDS = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, sid: sessionId },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

async function register({ username, password }) {
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    const err = new ValidationError({ username: ['Username already exists'] });
    err.message = 'Username already exists';
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { username, passwordHash },
    select: { id: true, username: true, role: true, preferences: true },
  });

  return { user };
}

async function login({ username, password }) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new UnauthorizedError('Invalid username or password');

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid username or password');

  // Generate a new sessionId and store it — invalidates any previous session
  const sessionId = crypto.randomUUID();
  await prisma.user.update({
    where: { id: user.id },
    data: { activeSessionId: sessionId },
  });

  const token = signToken(user, sessionId);
  return {
    token,
    user: { id: user.id, username: user.username, role: user.role, preferences: user.preferences },
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
    select: { id: true, username: true, role: true, preferences: true },
  });
  return user;
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
    select: { id: true, username: true, role: true, activeSessionId: true },
  });
  if (!user) throw new UnauthorizedError('User not found');
  if (user.role === 'PENDING') throw new UnauthorizedError('Account not approved');

  // Check session is still the active one (if session restriction is in effect)
  if (user.activeSessionId && payload.sid && user.activeSessionId !== payload.sid) {
    const err = new Error('Your account was logged in on another device');
    err.status = 403;
    err.code = 'SESSION_REPLACED';
    throw err;
  }

  // Reuse the same sessionId — only login generates a new one.
  // This avoids a race condition where two tabs refreshing simultaneously
  // would generate different sids, causing one tab to get SESSION_REPLACED.
  const newToken = signToken(user, payload.sid || user.activeSessionId);
  return { token: newToken };
}

module.exports = { register, login, getMe, changePassword, changeUsername, updatePreferences, refreshToken };
