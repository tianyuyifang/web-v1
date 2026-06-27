const { z } = require('zod');

const createPlaylistSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  isPublic: z.boolean().optional().default(false),
});

const updatePlaylistSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional().nullable(),
  isPublic: z.boolean().optional(),
});

const addClipSchema = z.object({
  clipId: z.string().uuid(),
});

const reorderClipsSchema = z.object({
  clipIds: z.array(z.string().uuid()),
});

const updateClipCustomizationSchema = z.object({
  speed: z.number().min(0.5).max(2.0).optional(),
  // speed values: 0.9, 0.95, 1.0, 1.1, 1.2, 1.3
  pitch: z.number().int().min(-12).max(12).optional(),
  colorTag: z.string().regex(/^(#[0-9A-Fa-f]{6})(\|#[0-9A-Fa-f]{6})*$/).optional().nullable(),
  comment: z.string().max(500).optional().nullable(),
  sectionLabel: z.string().max(100).optional().nullable(),
});

const shareSchema = z.object({
  userId: z.string().uuid(),
});

const AB = z.enum(['A', 'B']);
const ABC = z.enum(['A', 'B', 'combine']);

const mergeOptionsSchema = z.object({
  speed: AB.optional(),
  pitch: AB.optional(),
  comment: ABC.optional(),
  colorTag: ABC.optional(),
  sectionLabel: AB.optional(),
  clipCut: AB.optional(),
  order: AB.optional(),
}).optional();

const mergePlaylistSchema = z.object({
  aId: z.string().uuid(),
  bId: z.string().uuid(),
  options: mergeOptionsSchema,
}).refine((d) => d.aId !== d.bId, {
  message: 'aId and bId must differ',
});

module.exports = {
  createPlaylistSchema,
  updatePlaylistSchema,
  addClipSchema,
  reorderClipsSchema,
  updateClipCustomizationSchema,
  shareSchema,
  mergePlaylistSchema,
  mergeOptionsSchema,
};
