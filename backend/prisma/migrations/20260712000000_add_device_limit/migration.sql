ALTER TABLE "users" ADD COLUMN "device_limit" INTEGER;
ALTER TABLE "users" ADD COLUMN "active_sessions" JSONB DEFAULT '[]';

-- Backfill: preserve existing logins so nobody is logged out on deploy.
UPDATE "users"
SET "active_sessions" = jsonb_build_array(
  jsonb_build_object('sid', "active_session_id"::text, 'createdAt', now())
)
WHERE "active_session_id" IS NOT NULL;
