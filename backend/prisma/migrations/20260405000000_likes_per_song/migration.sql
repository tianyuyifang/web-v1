-- Migrate likes from (playlist_id, clip_id) to (playlist_id, song_id)

-- 1. Drop old foreign key to clips first
ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_clip_id_fkey";

-- 2. Add song_id column (nullable initially)
ALTER TABLE "likes" ADD COLUMN "song_id" UUID;

-- 3. Populate song_id from clips table
UPDATE "likes" l
SET "song_id" = c."song_id"
FROM "clips" c
WHERE l."clip_id" = c."id";

-- 4. Remove duplicates: keep only the earliest like per (playlist_id, song_id)
DELETE FROM "likes" a
USING "likes" b
WHERE a."playlist_id" = b."playlist_id"
  AND a."song_id" = b."song_id"
  AND a."created_at" > b."created_at";

-- 5. Make song_id non-nullable
ALTER TABLE "likes" ALTER COLUMN "song_id" SET NOT NULL;

-- 6. Drop old unique constraint (not the index)
ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_playlist_id_clip_id_key";

-- 7. Drop clip_id column
ALTER TABLE "likes" DROP COLUMN "clip_id";

-- 8. Add new unique constraint and foreign key
ALTER TABLE "likes" ADD CONSTRAINT "likes_playlist_id_song_id_key" UNIQUE ("playlist_id", "song_id");
ALTER TABLE "likes" ADD CONSTRAINT "likes_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "songs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
