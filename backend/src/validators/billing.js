const { z } = require('zod');

// All fields optional — admin PATCHes any subset. Nulls clear a field.
const updateBillingSchema = z.object({
  // Accept ISO date string or null; transform to Date (or null) for Prisma.
  expiresAt: z.string().datetime().nullable().optional()
    .transform((v) => (v == null ? v : new Date(v))),
  // Money: non-negative, up to 2 decimals. Kept as string for Prisma Decimal.
  monthlyFee: z.union([
    z.number().nonnegative(),
    z.string().regex(/^\d+(\.\d{1,2})?$/),
  ]).nullable().optional().transform((v) => (v == null ? v : String(v))),
  paymentStatus: z.enum(['PAID', 'UNPAID', 'OVERDUE']).nullable().optional(),
  billingNotes: z.string().max(1000).nullable().optional(),
});

module.exports = { updateBillingSchema };
