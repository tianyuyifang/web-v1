const prisma = require('../db/client');

/**
 * Middleware that tracks bytes sent per user per day, and when they last
 * actually listened.
 *
 * Attaches to the stream routes — both writes happen after the response has
 * finished, so nothing here is on the path of the audio itself.
 */

/**
 * When each user last had their listening time written down.
 *
 * Bytes have to be counted on every request, but "last listened" only needs to
 * be roughly right, and writing it per request would turn an hour of listening
 * into hundreds of updates of the same row. Five minutes is far finer than the
 * column is ever read at — the admin page shows it as "3 小时前" — and turns
 * that hour into a dozen writes.
 *
 * In memory, so a restart simply lets the next request through: the cost of
 * forgetting is one extra write, which is why this does not need to survive.
 * Bounded by the number of users who listen, and each entry is a number.
 */
const STREAM_WRITE_EVERY_MS = 5 * 60 * 1000;
const lastStreamWrite = new Map();
function trackBandwidth(req, res, next) {
  const userId = req.user?.id;
  if (!userId) return next();

  const originalWriteHead = res.writeHead;
  let contentLength = 0;

  res.writeHead = function (statusCode, ...args) {
    // Grab Content-Length from the headers we're about to send
    const headers = args[args.length - 1];
    if (headers && headers['Content-Length']) {
      contentLength = parseInt(headers['Content-Length'], 10) || 0;
    }
    return originalWriteHead.call(this, statusCode, ...args);
  };

  res.on('finish', () => {
    if (contentLength <= 0) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Fire-and-forget upsert — don't block the response
    prisma.bandwidthLog.upsert({
      where: { userId_date: { userId, date: today } },
      create: { userId, date: today, bytes: BigInt(contentLength) },
      update: { bytes: { increment: contentLength } },
    }).catch(() => {});

    // 听歌的时刻。和上面同一个 finish 回调、同样不等它, 但多一道节流。
    const now = Date.now();
    const wrote = lastStreamWrite.get(userId) || 0;
    if (now - wrote >= STREAM_WRITE_EVERY_MS) {
      // 先记下再写: 写失败也不重试, 下一个五分钟自然会再来一次, 而失败重试
      // 只会在数据库正难受的时候雪上加霜。
      lastStreamWrite.set(userId, now);
      prisma.user.update({
        where: { id: userId },
        data: { lastStreamAt: new Date(now) },
      }).catch(() => {});
    }
  });

  next();
}

module.exports = trackBandwidth;
