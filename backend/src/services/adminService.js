const prisma = require('../db/client');
const { NotFoundError, ForbiddenError } = require('../utils/errors');

/**
 * Returns all users ordered by creation date descending.
 * @returns {Promise<Array>}
 */
async function listUsers() {
  return prisma.user.findMany({
    select: { id: true, username: true, role: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
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

  return prisma.user.update({
    where: { id },
    data: { role: 'MEMBER' },
    select: { id: true, username: true, role: true },
  });
}

/**
 * Demotes a MEMBER back to PENDING.
 * @param {string} id - User UUID
 * @returns {Promise<object>}
 */
async function demoteUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot change admin role');

  return prisma.user.update({
    where: { id },
    data: { role: 'PENDING' },
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

module.exports = { listUsers, listPending, approveUser, demoteUser, deleteUser };
