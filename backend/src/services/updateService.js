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

/**
 * Toggle the highlight on an update. At most one update is highlighted at a time.
 * - If the target is already highlighted → turn it off (result: zero highlighted).
 * - Otherwise → clear any existing highlight, then highlight the target.
 * The two-step write runs in a transaction so the partial-unique-index invariant
 * (at most one is_highlighted = true) is never violated.
 * @param {string} id
 * @returns {Promise<object>} the updated target row
 */
async function toggleHighlight(id) {
  const existing = await prisma.update.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Update');

  if (existing.isHighlighted) {
    return prisma.update.update({ where: { id }, data: { isHighlighted: false } });
  }

  return prisma.$transaction(async (tx) => {
    // Clear any currently-highlighted row(s) first to satisfy the single-highlight index.
    await tx.update.updateMany({
      where: { isHighlighted: true },
      data: { isHighlighted: false },
    });
    return tx.update.update({ where: { id }, data: { isHighlighted: true } });
  });
}

/**
 * Get the currently-highlighted update, or null if none.
 * @returns {Promise<object|null>}
 */
async function getHighlighted() {
  return prisma.update.findFirst({ where: { isHighlighted: true } });
}

module.exports = { listUpdates, createUpdate, editUpdate, deleteUpdate, toggleHighlight, getHighlighted };
