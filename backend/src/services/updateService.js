const prisma = require('../db/client');
const { NotFoundError } = require('../utils/errors');

/**
 * List all updates, newest first.
 * @returns {Promise<Array>}
 */
async function listUpdates() {
  return prisma.update.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Create a new update.
 * @param {{ title: string, body: string, category: string }} data
 */
async function createUpdate(data) {
  return prisma.update.create({ data });
}

/**
 * Edit an existing update (partial).
 * @param {string} id
 * @param {{ title?: string, body?: string, category?: string }} data
 */
async function editUpdate(id, data) {
  const existing = await prisma.update.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Update');
  return prisma.update.update({ where: { id }, data });
}

/**
 * Delete an update.
 * @param {string} id
 */
async function deleteUpdate(id) {
  const existing = await prisma.update.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Update');
  await prisma.update.delete({ where: { id } });
}

module.exports = { listUpdates, createUpdate, editUpdate, deleteUpdate };
