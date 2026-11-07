-- 歌P战报: two new tables only; nothing existing is touched.

-- CreateTable
CREATE TABLE "gep_reports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "playlist_id" UUID,
    "platform_ref" TEXT,
    "playlist_name" TEXT NOT NULL,
    "singer" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "gep_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gep_report_items" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "raw_text" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL,
    "seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gep_report_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gep_reports_user_id_started_at_idx" ON "gep_reports"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "gep_reports_session_id_ended_at_idx" ON "gep_reports"("session_id", "ended_at");

-- CreateIndex
CREATE INDEX "gep_reports_started_at_idx" ON "gep_reports"("started_at");

-- CreateIndex
CREATE INDEX "gep_report_items_report_id_seen_at_idx" ON "gep_report_items"("report_id", "seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "gep_report_items_report_id_raw_text_key" ON "gep_report_items"("report_id", "raw_text");

-- AddForeignKey
ALTER TABLE "gep_reports" ADD CONSTRAINT "gep_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gep_report_items" ADD CONSTRAINT "gep_report_items_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "gep_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
