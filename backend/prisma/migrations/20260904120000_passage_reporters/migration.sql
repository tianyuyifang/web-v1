-- 报告者名单: 计数升级为「不同人数」, 悬停显示是谁报的
ALTER TABLE "lyric_passage_matches"
  ADD COLUMN "reporters" JSONB NOT NULL DEFAULT '[]';
