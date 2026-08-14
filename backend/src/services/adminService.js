const bcrypt = require('bcryptjs');
const prisma = require('../db/client');
const { NotFoundError, ForbiddenError } = require('../utils/errors');
const { addOneMonth } = require('../utils/billing');

const SALT_ROUNDS = 10;

// Unambiguous alphabet: no 0/O/1/l/I to avoid confusion when relaying the
// temp password out-of-band.
const TEMP_PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_PW_LENGTH = 12;

function generateTempPassword() {
  const bytes = require('crypto').randomBytes(TEMP_PW_LENGTH);
  let out = '';
  for (let i = 0; i < TEMP_PW_LENGTH; i++) {
    out += TEMP_PW_ALPHABET[bytes[i] % TEMP_PW_ALPHABET.length];
  }
  return out;
}

/**
 * Returns all users ordered by creation date descending.
 * @returns {Promise<Array>}
 */
async function listUsers() {
  const users = await prisma.user.findMany({
    select: {
      id: true, username: true, role: true, createdAt: true,
      expiresAt: true, monthlyFee: true, paymentStatus: true, billingNotes: true,
      deviceLimit: true, demotedAt: true,
      _count: { select: { playlists: true, sharedPlaylists: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  // Flatten counts: ownedCount = playlists this user owns; sharedCount = playlists shared WITH them.
  return users.map(({ _count, ...u }) => ({
    ...u,
    ownedCount: _count.playlists,
    sharedCount: _count.sharedPlaylists,
  }));
}

/**
 * Returns only users with role PENDING.
 * @returns {Promise<Array>}
 */
async function listPending() {
  return prisma.user.findMany({
    where: { role: 'PENDING' },
    select: { id: true, username: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Promotes a PENDING user to MEMBER.
 * @param {string} id - User UUID
 * @returns {Promise<object>}
 */
async function approveUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot change admin role');

  // Clearing demotedAt matters: an approved user is a member again, so a later
  // revocation should read as new rather than as the old one still standing.
  return prisma.user.update({
    where: { id },
    data: { role: 'MEMBER', demotedAt: null },
    select: { id: true, username: true, role: true },
  });
}

/**
 * Demotes a MEMBER back to PENDING, stamping when it happened so the admin
 * page can list revoked members apart from people who have never been approved.
 * @param {string} id - User UUID
 * @returns {Promise<object>}
 */
async function demoteUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot change admin role');

  return prisma.user.update({
    where: { id },
    data: { role: 'PENDING', demotedAt: new Date() },
    select: { id: true, username: true, role: true },
  });
}

/**
 * Deletes a user and all their associated data (cascaded by Prisma).
 * Admins cannot be deleted via this endpoint.
 * @param {string} id - User UUID
 * @param {string} requesterId - The admin making the request (cannot self-delete)
 */
async function deleteUser(id, requesterId) {
  if (id === requesterId) throw new ForbiddenError('Cannot delete your own account');

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot delete an admin account');

  await prisma.user.delete({ where: { id } });
}

/**
 * Returns bandwidth usage per user, with daily breakdown.
 * @param {number} days - Number of days to look back (default 30)
 * @returns {Promise<object>} { trackingSince, users: [{ userId, username, totalBytes, days: [{ date, bytes }] }] }
 */
async function getBandwidthStats(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  // Get earliest log date (tracking since)
  const earliest = await prisma.bandwidthLog.findFirst({
    orderBy: { date: 'asc' },
    select: { date: true },
  });

  const logs = await prisma.bandwidthLog.findMany({
    where: { date: { gte: since } },
    include: { user: { select: { username: true } } },
    orderBy: [{ userId: 'asc' }, { date: 'asc' }],
  });

  // Group by user
  const userMap = new Map();
  for (const log of logs) {
    if (!userMap.has(log.userId)) {
      userMap.set(log.userId, {
        userId: log.userId,
        username: log.user.username,
        totalBytes: BigInt(0),
        days: [],
      });
    }
    const entry = userMap.get(log.userId);
    entry.totalBytes += log.bytes;
    entry.days.push({ date: log.date, bytes: log.bytes.toString() });
  }

  // Sort by totalBytes descending
  const users = Array.from(userMap.values())
    .sort((a, b) => (b.totalBytes > a.totalBytes ? 1 : -1))
    .map(u => ({ ...u, totalBytes: u.totalBytes.toString() }));

  return {
    trackingSince: earliest?.date || null,
    periodDays: days,
    users,
  };
}

/**
 * Returns all playlists owned by the given user, for admin view-and-copy.
 * Shaped like playlistService.getUserPlaylists but from the admin's perspective:
 * the admin is never the owner, and may always copy.
 * @param {string} userId - The owner whose playlists to list
 * @returns {Promise<Array>}
 */
async function listUserPlaylists(userId) {
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });
  if (!owner) throw new NotFoundError('User');

  const shape = (p, isShared) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    isPublic: p.isPublic,
    isOwner: false,
    isShared,
    canCopy: true,
    ownerName: p.user.username,
    clipCount: p._count.playlistClips,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });

  // Playlists this user owns.
  const owned = await prisma.playlist.findMany({
    where: { userId },
    include: {
      _count: { select: { playlistClips: true } },
      user: { select: { username: true } },
    },
    orderBy: { name: 'asc' },
  });

  // Playlists shared WITH this user (via playlist_shares); owned by someone else.
  const sharedRows = await prisma.playlistShare.findMany({
    where: { userId },
    include: {
      playlist: {
        include: {
          _count: { select: { playlistClips: true } },
          user: { select: { username: true } },
        },
      },
    },
    orderBy: { playlist: { name: 'asc' } },
  });

  return {
    owner,
    playlists: owned.map((p) => shape(p, false)),
    sharedPlaylists: sharedRows.map((r) => shape(r.playlist, true)),
  };
}

const BILLING_SELECT = {
  id: true, username: true, role: true,
  expiresAt: true, monthlyFee: true, paymentStatus: true, billingNotes: true,
  deviceLimit: true,
};

/**
 * Update any subset of a user's billing fields.
 * @param {string} id
 * @param {{ expiresAt?: Date|null, monthlyFee?: string|number|null, paymentStatus?: string|null, billingNotes?: string|null }} data
 */
async function updateBilling(id, data) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');

  const patch = {};
  if ('expiresAt' in data) patch.expiresAt = data.expiresAt;
  if ('monthlyFee' in data) patch.monthlyFee = data.monthlyFee;
  if ('paymentStatus' in data) patch.paymentStatus = data.paymentStatus;
  if ('billingNotes' in data) patch.billingNotes = data.billingNotes;
  if ('deviceLimit' in data) patch.deviceLimit = data.deviceLimit;

  return prisma.user.update({ where: { id }, data: patch, select: BILLING_SELECT });
}

/**
 * Extend a user's subscription by one calendar month.
 * Base = now if expiresAt is null or in the past, else current expiresAt.
 * @param {string} id
 */
async function extendOneMonth(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');

  const now = new Date();
  const base = user.expiresAt && user.expiresAt.getTime() > now.getTime() ? user.expiresAt : now;
  const expiresAt = addOneMonth(base);

  return prisma.user.update({ where: { id }, data: { expiresAt }, select: BILLING_SELECT });
}

/**
 * Reset a user's password to a freshly generated temp password.
 * Returns the plaintext temp password ONCE so the admin can relay it; it is
 * never stored in plaintext. Admins cannot be reset here (recover via
 * scripts/seed-admins.js). Existing sessions are left intact — already-issued
 * JWTs stay valid until they expire; only new logins require the temp password.
 * @param {string} id - User UUID
 * @returns {Promise<{ id: string, username: string, tempPassword: string }>}
 */
async function resetPassword(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot reset an admin password');

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  await prisma.user.update({ where: { id }, data: { passwordHash } });

  return { id: user.id, username: user.username, tempPassword };
}

module.exports = { listUsers, listPending, approveUser, demoteUser, deleteUser, getBandwidthStats, listUserPlaylists, updateBilling, extendOneMonth, resetPassword, generateTempPassword };
