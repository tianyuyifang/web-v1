-- Split "connected" from "where the data goes".
--
-- A session used to be both at once: the token WAS the delivery target, so
-- switching playlists meant a new session, a new token, and the user typing the
-- pairing code again -- a dozen times over a long game. Now one connection
-- lasts the session and its target moves, which is what lets the code be typed
-- once.
ALTER TABLE "capture_sessions" ADD COLUMN "target" TEXT NOT NULL DEFAULT 'none';

-- Existing rows are already delivering somewhere, so carry that over from the
-- mode they were created with rather than defaulting them all one way: a blanket
-- 'playlist' would label the live sessions as delivering to a playlist they do
-- not have, and a blanket 'none' would silently stop the sessions currently
-- running.
UPDATE "capture_sessions" SET "target" = "mode";
