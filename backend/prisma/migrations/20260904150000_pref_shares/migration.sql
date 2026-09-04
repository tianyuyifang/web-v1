-- 好友标记分享: A 分享给 B = B 可读 A 的标记歌曲。单向、可取消。
CREATE TABLE "pref_shares" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "from_user_id" UUID NOT NULL,
  "to_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pref_shares_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pref_shares_from_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "pref_shares_to_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "pref_shares_from_user_id_to_user_id_key" ON "pref_shares"("from_user_id", "to_user_id");
CREATE INDEX "pref_shares_to_user_id_idx" ON "pref_shares"("to_user_id");
