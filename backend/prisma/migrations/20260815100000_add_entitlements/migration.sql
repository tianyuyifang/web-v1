-- Paid add-ons a user holds, e.g. ["capture"]. A list rather than a column
-- per feature, so the next add-on costs a string and not a migration.
ALTER TABLE "users" ADD COLUMN "entitlements" TEXT[] NOT NULL DEFAULT '{}';

-- Everyone who is already a member keeps auto-tagging. They have been using
-- it as an included feature, and taking it away to sell it back would be a
-- regression for them. New members start without it and buy it separately.
UPDATE "users" SET "entitlements" = ARRAY['capture'] WHERE "role" = 'MEMBER';
