-- Admin-authored update/announcement posts shown to users on /updates.
CREATE TYPE "UpdateCategory" AS ENUM ('FEATURE', 'FIX', 'ANNOUNCEMENT');

CREATE TABLE "updates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "UpdateCategory" NOT NULL DEFAULT 'ANNOUNCEMENT',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "updates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_updates_created_at" ON "updates"("created_at");
