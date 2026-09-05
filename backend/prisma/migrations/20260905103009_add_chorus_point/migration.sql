-- Where the chorus starts, and when we last asked.
--
-- Both nullable and with no default, so this is a metadata-only change: the
-- running backend does not know the columns exist and is unaffected until it
-- restarts. That is what lets `migrate deploy` run before `pm2 restart`
-- rather than after.
ALTER TABLE "imported_tracks" ADD COLUMN "chorus_ms" INTEGER;
ALTER TABLE "imported_tracks" ADD COLUMN "chorus_fetched_at" TIMESTAMPTZ;
