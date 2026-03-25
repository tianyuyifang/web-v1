-- DropIndex
DROP INDEX "idx_clips_song_id";

-- DropIndex
DROP INDEX "idx_likes_user_clips";

-- DropIndex
DROP INDEX "idx_likes_user_playlist";

-- DropIndex
DROP INDEX "idx_playlist_clips_clip";

-- DropIndex
DROP INDEX "idx_playlist_clips_playlist";

-- DropIndex
DROP INDEX "idx_playlist_copy_perms_playlist";

-- DropIndex
DROP INDEX "idx_playlist_copy_perms_user";

-- DropIndex
DROP INDEX "idx_playlist_shares_playlist";

-- DropIndex
DROP INDEX "idx_playlist_shares_user";

-- DropIndex
DROP INDEX "idx_playlists_name_pinyin_initials";

-- DropIndex
DROP INDEX "idx_playlists_name_pinyin_trgm";

-- DropIndex
DROP INDEX "idx_playlists_name_trgm";

-- DropIndex
DROP INDEX "idx_playlists_user_id";

-- DropIndex
DROP INDEX "idx_song_artists_initials";

-- DropIndex
DROP INDEX "idx_song_artists_name_trgm";

-- DropIndex
DROP INDEX "idx_song_artists_pinyin_trgm";

-- DropIndex
DROP INDEX "idx_song_artists_song_id";

-- DropIndex
DROP INDEX "idx_songs_artist_trgm";

-- DropIndex
DROP INDEX "idx_songs_title_pinyin_initials";

-- DropIndex
DROP INDEX "idx_songs_title_pinyin_trgm";

-- DropIndex
DROP INDEX "idx_songs_title_trgm";

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "password_reset_tokens"("token");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
