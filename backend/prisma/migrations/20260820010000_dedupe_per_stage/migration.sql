-- Dedupe per stage as well as per destination.
--
-- The same song appears on the picking screen and again while it is sung, with
-- byte-identical text. The old key rejected the second one, which is exactly
-- the row that carries the lyrics -- so the words could never be stored at all.
--
-- COALESCE on both nullable columns: Postgres treats NULLs as distinct in a
-- unique index, which would switch deduping off entirely for the rows that
-- have no playlist (every 唱卡 capture) or no stage (every client older than
-- v15) -- and those are precisely the rows that repeat most.
DROP INDEX IF EXISTS "capture_events_dedupe_key";

CREATE UNIQUE INDEX "capture_events_dedupe_key"
    ON "capture_events" (
        "session_id",
        COALESCE("playlist_id", '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE("stage", 'picking'),
        "raw_text"
    );
