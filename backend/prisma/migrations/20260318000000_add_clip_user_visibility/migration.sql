-- AlterTable: add userId and isGlobal to clips
ALTER TABLE "clips" ADD COLUMN "user_id" UUID;
ALTER TABLE "clips" ADD COLUMN "is_global" BOOLEAN NOT NULL DEFAULT true;

-- Drop the old unique constraint on (song_id, start)
ALTER TABLE "clips" DROP CONSTRAINT IF EXISTS "clips_song_id_start_key";

-- Add foreign key for user_id
ALTER TABLE "clips" ADD CONSTRAINT "clips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add index for efficient clip lookups by song + user
CREATE INDEX "clips_song_id_user_id_idx" ON "clips"("song_id", "user_id");
