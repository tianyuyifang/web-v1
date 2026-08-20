-- Pin each capture to the playlist it was captured for.
--
-- The destination used to be a property of the session, which was safe only
-- because a session never outlived one playlist. Now a connection is aimed and
-- re-aimed while it runs, so reading the session at approval time answers
-- "where are captures going NOW", not "where did this one come from" -- and a
-- song approved after switching was liked into the playlist the user had moved
-- to, visible to everyone who can see it. Aiming at 唱卡 made it worse: the
-- column is null there, and approving crashed.
ALTER TABLE "capture_events" ADD COLUMN "playlist_id" UUID;

-- Backfill from the session. Historical rows were captured under the old rule,
-- where the session's playlist could not have moved, so it is the right answer
-- for every one of them.
UPDATE "capture_events" e
   SET "playlist_id" = s."playlist_id"
  FROM "capture_sessions" s
 WHERE e."session_id" = s."id";

CREATE INDEX "capture_events_playlist_id_idx" ON "capture_events"("playlist_id");
