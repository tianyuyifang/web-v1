const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
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

  const token = signToken(user);
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

module.exports = { register, login, getMe, changePassword, changeUsername, updatePreferences };
