-- Revert likes from (playlist_id, song_id) back to (playlist_id, clip_id)

-- 1. Add clip_id column (nullable initially)
ALTER TABLE "likes" ADD COLUMN "clip_id" UUID;

-- 2. Populate clip_id by picking the first clip (by start) for each song
UPDATE "likes" l
SET "clip_id" = sub."clip_id"
FROM (
  SELECT DISTINCT ON (c."song_id") c."song_id", c."id" AS "clip_id"
  FROM "clips" c
  ORDER BY c."song_id", c."start" ASC
) sub
WHERE l."song_id" = sub."song_id";

-- 3. Delete any likes where we couldn't find a clip (orphaned)
DELETE FROM "likes" WHERE "clip_id" IS NULL;

-- 4. Make clip_id non-nullable
ALTER TABLE "likes" ALTER COLUMN "clip_id" SET NOT NULL;

-- 5. Drop song_id constraint and FK
ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_playlist_id_song_id_key";
ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_song_id_fkey";

-- 6. Drop song_id column
ALTER TABLE "likes" DROP COLUMN "song_id";

-- 7. Restore old unique constraint and FK to clips
ALTER TABLE "likes" ADD CONSTRAINT "likes_playlist_id_clip_id_key" UNIQUE ("playlist_id", "clip_id");
ALTER TABLE "likes" ADD CONSTRAINT "likes_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
