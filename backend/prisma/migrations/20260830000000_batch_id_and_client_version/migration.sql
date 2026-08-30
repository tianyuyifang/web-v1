-- Two things a capture client can tell us that it never has: which round of
-- songs a capture belongs to, and which build is reporting.
--
-- The round is what de-duplication actually wants. Without it the server can
-- only approximate with a time window, because gaps within a round and gaps
-- between rounds are both 25-35 seconds. Deriving it from the existing `stage`
-- column was tried and measured: the picking/singing judgement flickers inside
-- a single round, and splitting on it cut one session's 339 captures into 69
-- "rounds", many spanning zero seconds.
--
-- The version is for diagnosis. Nothing recorded it, so a report of odd
-- behaviour could not be checked against the build it came from.
--
-- Both nullable, and both must stay that way: every build shipped so far sends
-- neither, and the server has to keep working for them unchanged. Nullable
-- columns are a catalogue change on PostgreSQL 11+, so this takes no rewrite
-- and no meaningful lock, and is safe to apply while the site is serving.

ALTER TABLE "capture_events"   ADD COLUMN "batch_id"       TEXT;
ALTER TABLE "capture_sessions" ADD COLUMN "client_version" INTEGER;

-- De-duplication looks up (session, batch, raw_text) on every capture that
-- carries a batch, which is the hot path once clients start sending one.
CREATE INDEX "capture_events_session_batch_idx"
  ON "capture_events" ("session_id", "batch_id");
