-- 唱卡 play outcomes per recording, singer and day: one new table only;
-- nothing existing is touched.

-- CreateTable
CREATE TABLE "track_plays" (
    "source" "SongSource" NOT NULL,
    "external_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "ok" INTEGER NOT NULL DEFAULT 0,
    "refused" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "last_ok_at" TIMESTAMPTZ,
    "last_refused_at" TIMESTAMPTZ,
    "last_reason" TEXT,

    CONSTRAINT "track_plays_pkey" PRIMARY KEY ("source","external_id","user_id","day")
);

-- CreateIndex
CREATE INDEX "track_plays_day_idx" ON "track_plays"("day");

-- AddForeignKey
ALTER TABLE "track_plays" ADD CONSTRAINT "track_plays_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
