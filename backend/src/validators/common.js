const { z } = require('zod');

const uuidParam = z.string().uuid();

const paginationQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

const searchQuery = z.object({
  q: z.string().max(200).optional().default(''),
});

module.exports = { uuidParam, paginationQuery, searchQuery };
