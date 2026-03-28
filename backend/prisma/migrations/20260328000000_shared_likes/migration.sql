-- Shared likes: one like per (playlist, clip) instead of per (user, playlist, clip)

-- First, deduplicate: keep only one like per (playlist_id, clip_id)
DELETE FROM likes a USING likes b
WHERE a.id > b.id
  AND a.playlist_id = b.playlist_id
  AND a.clip_id = b.clip_id;

-- Drop the old unique constraint and indexes
DROP INDEX IF EXISTS "likes_user_id_playlist_id_clip_id_key";
DROP INDEX IF EXISTS "likes_playlist_id_clip_id_idx";
DROP INDEX IF EXISTS "likes_user_id_playlist_id_idx";

-- Make user_id optional (tracks who last toggled)
ALTER TABLE "likes" ALTER COLUMN "user_id" DROP NOT NULL;

-- Add new unique constraint on (playlist_id, clip_id)
ALTER TABLE "likes" ADD CONSTRAINT "likes_playlist_id_clip_id_key" UNIQUE ("playlist_id", "clip_id");

-- Add index on playlist_id for efficient lookups
CREATE INDEX "likes_playlist_id_idx" ON "likes"("playlist_id");

-- Change foreign key from CASCADE to SET NULL for user deletion
ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_user_id_fkey";
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
