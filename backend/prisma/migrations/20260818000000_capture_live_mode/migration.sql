-- Capture sessions gain a mode, and lose the requirement to name a playlist.
--
-- The 唱卡 (live cards) flow has no playlist: songs are read off the game
-- screen and resolved against the mapping table, not liked into a list. The
-- existing 歌P flow keeps working exactly as before -- hence the default,
-- which makes every existing row a 'playlist' session without a backfill.
ALTER TABLE "capture_sessions" ALTER COLUMN "playlist_id" DROP NOT NULL;
ALTER TABLE "capture_sessions" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'playlist';
