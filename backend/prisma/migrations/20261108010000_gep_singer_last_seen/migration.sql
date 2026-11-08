-- 歌P 歌手库「最近出现」: one nullable column, no default, no backfill.
-- Adding a nullable column without a default only changes the catalogue;
-- existing rows are not rewritten.

-- AlterTable
ALTER TABLE "gep_singer_songs" ADD COLUMN "last_seen_at" TIMESTAMPTZ;
