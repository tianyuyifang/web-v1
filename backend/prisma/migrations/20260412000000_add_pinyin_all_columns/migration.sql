-- AlterTable: add pinyin_all columns for polyphonic character search
ALTER TABLE "songs" ADD COLUMN "title_pinyin_all" TEXT;
ALTER TABLE "songs" ADD COLUMN "artist_pinyin_all" TEXT;

ALTER TABLE "song_artists" ADD COLUMN "artist_pinyin_all" TEXT;

ALTER TABLE "playlists" ADD COLUMN "name_pinyin_all" TEXT;

-- GIN trigram indexes for fuzzy search on the new columns
CREATE INDEX idx_songs_title_pinyin_all_trgm ON "songs" USING gin ("title_pinyin_all" gin_trgm_ops);
CREATE INDEX idx_songs_artist_pinyin_all_trgm ON "songs" USING gin ("artist_pinyin_all" gin_trgm_ops);
CREATE INDEX idx_song_artists_pinyin_all_trgm ON "song_artists" USING gin ("artist_pinyin_all" gin_trgm_ops);
