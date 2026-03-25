-- Enable pg_trgm extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Song search indexes
CREATE INDEX idx_songs_title_trgm ON songs USING GIN (title gin_trgm_ops);
CREATE INDEX idx_songs_title_pinyin_trgm ON songs USING GIN (title_pinyin gin_trgm_ops);
CREATE INDEX idx_songs_title_pinyin_initials ON songs(title_pinyin_initials);
CREATE INDEX idx_songs_artist_trgm ON songs USING GIN (artist gin_trgm_ops);

-- Song artists search indexes
CREATE INDEX idx_song_artists_song_id ON song_artists(song_id);
CREATE INDEX idx_song_artists_name_trgm ON song_artists USING GIN (artist_name gin_trgm_ops);
CREATE INDEX idx_song_artists_pinyin_trgm ON song_artists USING GIN (artist_pinyin gin_trgm_ops);
CREATE INDEX idx_song_artists_initials ON song_artists(artist_pinyin_initials);

-- Clips
CREATE INDEX idx_clips_song_id ON clips(song_id);

-- Playlist search indexes
CREATE INDEX idx_playlists_user_id ON playlists(user_id);
CREATE INDEX idx_playlists_public ON playlists(is_public) WHERE is_public = true;
CREATE INDEX idx_playlists_name_trgm ON playlists USING GIN (name gin_trgm_ops);
CREATE INDEX idx_playlists_name_pinyin_trgm ON playlists USING GIN (name_pinyin gin_trgm_ops);
CREATE INDEX idx_playlists_name_pinyin_initials ON playlists(name_pinyin_initials);

-- Playlist shares
CREATE INDEX idx_playlist_shares_playlist ON playlist_shares(playlist_id);
CREATE INDEX idx_playlist_shares_user ON playlist_shares(user_id);

-- Playlist copy permissions
CREATE INDEX idx_playlist_copy_perms_playlist ON playlist_copy_permissions(playlist_id);
CREATE INDEX idx_playlist_copy_perms_user ON playlist_copy_permissions(user_id);

-- Playlist clips
CREATE INDEX idx_playlist_clips_playlist ON playlist_clips(playlist_id, position);
CREATE INDEX idx_playlist_clips_clip ON playlist_clips(clip_id);
CREATE INDEX idx_playlist_clips_color ON playlist_clips(playlist_id, color_tag) WHERE color_tag IS NOT NULL;

-- Likes
CREATE INDEX idx_likes_user_playlist ON likes(user_id, playlist_id);
CREATE INDEX idx_likes_user_clips ON likes(user_id);
