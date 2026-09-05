-- 唱卡集: 游戏里出现过的每一段词各留一行, 不随 capture_events 的 30 天清理过期。
--
-- 两张新表, 不改动任何既有表 —— 所以运行中的后端完全不受影响, 这条可以在
-- 重启之前跑。
CREATE TABLE "passage_catalogue" (
    "id" UUID NOT NULL,
    "raw_text" TEXT NOT NULL,
    "lyric" TEXT NOT NULL,
    "seen" INTEGER NOT NULL DEFAULT 0,
    "first_seen" TIMESTAMPTZ NOT NULL,
    "last_seen" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "passage_catalogue_pkey" PRIMARY KEY ("id")
);

-- 同步靠它认「这一段见过没有」。lyric 实测最长 226 字符, 远在索引上限之内。
CREATE UNIQUE INDEX "passage_catalogue_raw_text_lyric_key"
    ON "passage_catalogue"("raw_text", "lyric");
CREATE INDEX "passage_catalogue_seen_idx" ON "passage_catalogue"("seen");

-- 单行表: 上次同步到哪个时刻。没有它, 每次打开都会把整张流水重数一遍并重复累加。
CREATE TABLE "passage_catalogue_sync" (
    "id" TEXT NOT NULL,
    "synced_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "passage_catalogue_sync_pkey" PRIMARY KEY ("id")
);
