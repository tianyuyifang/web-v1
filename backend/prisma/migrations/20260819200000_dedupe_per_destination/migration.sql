-- Dedupe per destination, not per connection.
--
-- A title sits on screen for seconds and is read over and over, so captures
-- must be deduped. The old key was (session, text), which was right only while
-- a session meant one playlist. Now a connection is re-aimed while it runs, so
-- that key means "this game", and tagging the same song into a second playlist
-- was answered "duplicate" -- the song silently never appeared there, with
-- nothing on screen to say why.
--
-- COALESCE because Postgres treats NULLs as distinct in a unique index, which
-- would drop deduping entirely for 唱卡 captures (playlist_id is null there) --
-- exactly where a title is re-read most.
DROP INDEX IF EXISTS "capture_events_session_id_raw_text_key";

CREATE UNIQUE INDEX "capture_events_dedupe_key"
    ON "capture_events" ("session_id", COALESCE("playlist_id", '00000000-0000-0000-0000-000000000000'::uuid), "raw_text");
