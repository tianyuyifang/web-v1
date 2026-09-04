-- 段落报告: 「段落点不准确」按钮的计数。审核队列按它排序;
-- 已确认的行被继续报告只标不降级, 审核者改动后清零。
ALTER TABLE "lyric_passage_matches"
  ADD COLUMN "report_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_reported_at" TIMESTAMPTZ;
