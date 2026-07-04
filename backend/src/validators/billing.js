const { z } = require('zod');

// All fields optional — admin PATCHes any subset. Nulls clear a field.
const updateBillingSchema = z.object({
  // Accept ISO date string or null; transform to Date (or null) for Prisma.
  expiresAt: z.string().datetime().nullable().optional()
    .transform((v) => (v == null ? v : new Date(v))),
  // Money: non-negative, up to 2 decimals. Kept as string for Prisma Decimal.
  // Both number and string inputs are normalized to a string and validated
  // against the same regex, so a number like 30.001 can't sneak past a
  // decimal-place check that only applied to the string branch.
  monthlyFee: z.union([z.number().nonnegative(), z.string()])
    .nullable().optional()
    .transform((v) => (v == null ? v : String(v)))
    .refine((v) => v == null || /^\d+(\.\d{1,2})?$/.test(v), {
      message: 'monthlyFee must be a non-negative number with at most 2 decimal places',
    }),
  paymentStatus: z.enum(['PAID', 'UNPAID', 'OVERDUE']).nullable().optional(),
  billingNotes: z.string().max(1000).nullable().optional(),
});

module.exports = { updateBillingSchema };
