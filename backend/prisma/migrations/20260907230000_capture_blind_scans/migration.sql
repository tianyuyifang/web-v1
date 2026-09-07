-- 抓取健康度：客户端连续扫空的次数，和它最后一次真读到是多少秒前。
--
-- 加它是因为「抓不到」以前没有任何信号。2026-09-07 九个用户连着两三天
-- 心跳正常却一首歌都没有（游戏给歌名打了 accessibilityDataSensitive，
-- Android 14+ 就把那个节点对我们藏了），服务端看到的一切都正常。
--
-- 可空：旧客户端不上报，保持 NULL，与「报了 0」区分得开。
ALTER TABLE "capture_sessions" ADD COLUMN "blind_scans" INTEGER;
ALTER TABLE "capture_sessions" ADD COLUMN "last_read_ago" INTEGER;
