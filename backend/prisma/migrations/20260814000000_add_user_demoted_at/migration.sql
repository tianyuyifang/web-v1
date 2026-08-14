-- Records when an admin revoked a MEMBER back to PENDING, so the admin page can
-- tell a revoked member apart from a brand-new signup. Cleared on approval.
-- Existing rows get NULL: past revocations were never recorded and cannot be
-- recovered, so they read as new applicants.
ALTER TABLE "users" ADD COLUMN "demoted_at" TIMESTAMPTZ;
