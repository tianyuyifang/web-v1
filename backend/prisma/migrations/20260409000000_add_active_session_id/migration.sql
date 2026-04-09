-- Add active_session_id column for single-session enforcement.
-- NULL means no restriction (backwards compatible for users who haven't logged in since this migration).
ALTER TABLE "users" ADD COLUMN "active_session_id" UUID;
