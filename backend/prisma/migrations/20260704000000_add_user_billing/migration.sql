-- Per-user monthly subscription billing. All columns nullable (backwards compatible).
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'UNPAID', 'OVERDUE');

ALTER TABLE "users" ADD COLUMN "expires_at" TIMESTAMPTZ;
ALTER TABLE "users" ADD COLUMN "monthly_fee" DECIMAL(10,2);
ALTER TABLE "users" ADD COLUMN "payment_status" "PaymentStatus";
ALTER TABLE "users" ADD COLUMN "billing_notes" TEXT;
