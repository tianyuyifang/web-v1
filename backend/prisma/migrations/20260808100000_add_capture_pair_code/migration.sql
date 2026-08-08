-- AlterTable
ALTER TABLE "capture_sessions" ADD COLUMN "pair_code" TEXT;
ALTER TABLE "capture_sessions" ADD COLUMN "pair_expires_at" TIMESTAMPTZ;

-- CreateIndex
CREATE UNIQUE INDEX "capture_sessions_pair_code_key" ON "capture_sessions"("pair_code");
