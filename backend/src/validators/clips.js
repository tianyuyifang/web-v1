const { z } = require('zod');

const createClipSchema = z.object({
  songId: z.string().uuid(),
  start: z.number().int().min(0),
  length: z.number().int().refine((v) => v === 20, {
    message: 'Length must be 20',
  }),
  force: z.boolean().optional(),
});

const autoClipSchema = z.object({
  songId: z.string().uuid(),
  length: z.number().int().refine((v) => v === 20, {
    message: 'Length must be 20',
  }).default(20),
});

module.exports = { createClipSchema, autoClipSchema };
