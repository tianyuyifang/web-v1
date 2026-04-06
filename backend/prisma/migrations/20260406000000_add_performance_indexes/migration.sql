-- Add composite index for faster clip reordering and position lookups
CREATE INDEX IF NOT EXISTS "idx_playlist_clips_playlist_position" ON "playlist_clips" ("playlist_id", "position");
