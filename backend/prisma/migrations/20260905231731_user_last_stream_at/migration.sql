-- 最后一次听歌的时刻。
--
-- 可空、无默认值 —— 纯元数据改动, 运行中的后端不知道这一列存在, 不受影响。
-- 所以 migrate deploy 可以先于 pm2 restart 跑。
ALTER TABLE "users" ADD COLUMN "last_stream_at" TIMESTAMPTZ;
