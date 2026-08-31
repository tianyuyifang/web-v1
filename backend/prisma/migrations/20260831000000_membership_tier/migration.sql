-- A membership tier per user. Nullable: existing rows and pre-tier signups
-- carry no tier until an admin (or the one-time backfill) sets one. Adding a
-- nullable column is a catalogue-only change on PostgreSQL — no table rewrite,
-- safe to run while the app is serving.
ALTER TABLE "users" ADD COLUMN "tier" TEXT;
