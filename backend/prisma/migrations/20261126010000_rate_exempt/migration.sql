-- Whitelist for the usage limits: an account an admin trusts is counted and
-- still raises alerts, but is never refused or auto-revoked.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "rate_exempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "rate_alerts" ADD COLUMN "exempt" BOOLEAN NOT NULL DEFAULT false;
