const prisma = require('../db/client');

/**
 * Middleware that tracks bytes sent per user per day.
 * Attaches to stream routes — records Content-Length after response finishes.
 */
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
  });

  next();
}

module.exports = trackBandwidth;
