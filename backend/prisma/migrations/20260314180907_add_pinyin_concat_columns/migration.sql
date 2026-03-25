-- AlterTable
ALTER TABLE "song_artists" ADD COLUMN     "artist_pinyin_concat" TEXT;

-- AlterTable
ALTER TABLE "songs" ADD COLUMN     "artist_pinyin_concat" TEXT,
ADD COLUMN     "title_pinyin_concat" TEXT;

-- Trigram indexes for fuzzy search on concat columns
CREATE INDEX idx_songs_title_pinyin_concat_trgm ON songs USING GIN (title_pinyin_concat gin_trgm_ops);
CREATE INDEX idx_songs_artist_pinyin_concat_trgm ON songs USING GIN (artist_pinyin_concat gin_trgm_ops);
CREATE INDEX idx_song_artists_pinyin_concat_trgm ON song_artists USING GIN (artist_pinyin_concat gin_trgm_ops);
