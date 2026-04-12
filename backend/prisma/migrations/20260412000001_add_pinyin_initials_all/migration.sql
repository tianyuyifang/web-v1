-- AlterTable: add pinyin_initials_all columns for polyphonic initial search
ALTER TABLE "songs" ADD COLUMN "title_pinyin_initials_all" TEXT;
ALTER TABLE "songs" ADD COLUMN "artist_pinyin_initials_all" TEXT;

ALTER TABLE "song_artists" ADD COLUMN "artist_pinyin_initials_all" TEXT;
