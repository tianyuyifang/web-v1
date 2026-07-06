const { z } = require('zod');

// Create requires all fields; category defaults to ANNOUNCEMENT if omitted.
const createUpdateSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  category: z.enum(['FEATURE', 'FIX', 'ANNOUNCEMENT', 'SONG_UPDATE']).default('ANNOUNCEMENT'),
});

// Update (edit) — all fields optional, but at least one must be present.
const editUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(5000).optional(),
  category: z.enum(['FEATURE', 'FIX', 'ANNOUNCEMENT', 'SONG_UPDATE']).optional(),
}).refine((d) => Object.keys(d).length > 0, {
  message: 'At least one field is required',
});

module.exports = { createUpdateSchema, editUpdateSchema };
