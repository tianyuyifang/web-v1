-- Let a 唱卡 song come round again.
--
-- The dedupe key was unique on (session, playlist, stage, raw_text), which
-- assumed one appearance of a song per session. That holds for 歌P, where a
-- playlist is tagged once. It does not hold for 唱卡: a session runs two to
-- four hours and 100-225 songs, and the game offers the same song in later
-- rounds. The second appearance found the first row and was discarded, so a
-- song seen once never produced a card again for the rest of the run.
--
-- The service now bounds that lookup to a five-minute window, which stands in
-- for the round the client does not report. A unique key here would refuse the
-- insert the service has decided to make, so the constraint is dropped and the
-- index kept: the lookup still needs to be fast, it just must not be a gate.
--
-- Uniqueness moves to one place rather than two. The service already reads
-- before it writes, and the client sends captures on a single thread
-- (Executors.newSingleThreadExecutor, and a client-side sent-set on top), so
-- the race this constraint guarded is not one this application can produce.
--
-- That invariant is now enforced by the client rather than the database, which
-- is worth knowing before anything changes it: a second device paired to one
-- token, or a retry issued in parallel rather than after the first returns,
-- would remove the last guard. The damage would be bounded even then -- likes
-- carry their own unique key on (playlist_id, clip_id) and ensureLiked catches
-- the violation -- so the worst case is a duplicate receipt row, not a
-- duplicate like.
--
-- Reverting is not symmetrical. Once the window has let a repeat through,
-- recreating a UNIQUE index would fail on the rows it was added to allow. The
-- rollback is "revert the code and leave the index non-unique", which is safe:
-- the old service deduplicates at the service level regardless.
DROP INDEX IF EXISTS "capture_events_dedupe_key";

CREATE INDEX IF NOT EXISTS "capture_events_dedupe_lookup"
    ON "capture_events" (
        "session_id",
        COALESCE("playlist_id", '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE("stage", 'picking'),
        "raw_text"
    );
