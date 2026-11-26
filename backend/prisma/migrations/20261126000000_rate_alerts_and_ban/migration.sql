-- Usage limits: a ban flag on users, and the alerts the admin page shows.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "banned_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "rate_alerts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "limit_value" INTEGER NOT NULL,
    "episodes" INTEGER NOT NULL DEFAULT 0,
    "auto_revoked" BOOLEAN NOT NULL DEFAULT false,
    "first_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_at" TIMESTAMPTZ,

    CONSTRAINT "rate_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rate_alerts_user_id_category_day_key" ON "rate_alerts"("user_id", "category", "day");

-- CreateIndex
CREATE INDEX "rate_alerts_acked_at_idx" ON "rate_alerts"("acked_at");

-- CreateIndex
CREATE INDEX "rate_alerts_first_at_idx" ON "rate_alerts"("first_at");
