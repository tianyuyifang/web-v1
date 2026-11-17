-- 歌P 待处理: when the current 待处理 began (needs_review_at moves on with
-- every capture). One nullable column; titles already 待处理 start from their
-- latest mark, the best that is known about them.

-- AlterTable
ALTER TABLE "gep_singer_songs" ADD COLUMN "review_since" TIMESTAMPTZ;

UPDATE "gep_singer_songs" SET "review_since" = "needs_review_at" WHERE "needs_review_at" IS NOT NULL;
