-- CreateIndex
CREATE INDEX IF NOT EXISTS "song_artists_song_id_idx" ON "song_artists"("song_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "clips_song_id_start_idx" ON "clips"("song_id", "start");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "playlist_clips_clip_id_idx" ON "playlist_clips"("clip_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "likes_playlist_id_clip_id_idx" ON "likes"("playlist_id", "clip_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "likes_user_id_playlist_id_idx" ON "likes"("user_id", "playlist_id");
