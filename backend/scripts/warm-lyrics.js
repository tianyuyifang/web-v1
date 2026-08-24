/**
 * Fetch the catalogue's lyrics once, so nobody's browsing has to.
 *
 * The lyric call is the only outbound path that carries no credential, which
 * means it leaves as the server over the one address every user shares -- and
 * these platforms rate-limit by address, not by account. Measured before the
 * store existed: 7.2 requests a second sustained, ~26k an hour, all charged to
 * this machine. Every row this fills is a request no listener will ever make.
 *
 * Run it after importing a playlist. Rows already fetched are skipped, so a
 * second run costs one query and finishing an interrupted run is just running
 * it again.
 *
 *   node scripts/warm-lyrics.js              # 50 tracks, to see it work
 *   node scripts/warm-lyrics.js --all        # the rest of the catalogue
 *   node scripts/warm-lyrics.js --all --gap 500
 *
 * On pacing. This is the one caller that can choose its own speed -- nobody is
 * waiting for it -- so it takes the slowest setting that still finishes in one
 * sitting. At the default 300ms the whole catalogue is about twenty minutes of
 * traffic spread thin, well under the 5/s ceiling qqSource enforces anyway.
 *
 * It stops dead when the breaker opens rather than backing off and continuing.
 * A throttle means "not now", and the run can be finished tomorrow from where
 * it stopped -- there is no deadline here, and pushing through a rate limit is
 * how a slow inconvenience becomes hours of blocked access for everybody.
 */
require('dotenv').config();

const prisma = require('../src/db/client');
const qq = require('../src/services/sources/qqSource');
const netease = require('../src/services/sources/neteaseLogin');
const store = require('../src/services/lyricStore');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const gapArg = args.indexOf('--gap');
const GAP_MS = gapArg >= 0 ? Number(args[gapArg + 1]) || 300 : 300;
const LIMIT = ALL ? undefined : 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bar(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const filled = Math.round(pct / 4);
  return `[${'#'.repeat(filled)}${'.'.repeat(25 - filled)}] ${pct}%`;
}

async function main() {
  const pending = await prisma.importedTrack.findMany({
    where: { lyricFetchedAt: null, source: { in: ['QQ', 'NETEASE'] } },
    select: { id: true, source: true, externalId: true, title: true },
    orderBy: { createdAt: 'asc' },
    take: LIMIT,
  });

  const remaining = await prisma.importedTrack.count({
    where: { lyricFetchedAt: null, source: { in: ['QQ', 'NETEASE'] } },
  });

  if (!pending.length) {
    console.log('Every track already has its lyrics. Nothing to do.');
    return;
  }

  console.log(`${remaining} track(s) without lyrics; fetching ${pending.length}.`);
  console.log(`Pacing: ${GAP_MS}ms between calls. Ctrl-C is safe -- progress is saved per track.\n`);

  let got = 0; let none = 0; let failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < pending.length; i += 1) {
    const t = pending[i];
    try {
      const r = t.source === 'QQ'
        ? await qq.getLyric(t.externalId)
        : await netease.getLyric(t.externalId);

      await store.store(t.source, t.externalId, r.lyric);
      if (r.lyric) got += 1; else none += 1;
    } catch (err) {
      // The breaker opening is the platform saying "enough". Anything else is
      // this one track's problem, so the run carries on past it.
      if (err.code === 'SOURCE_RATE_LIMITED' || err.code === 'SOURCE_UNAVAILABLE' || err.breakerOpened) {
        console.error(`\n\nStopped at ${i + 1}/${pending.length}: ${err.message}`);
        console.error('Run again later; finished tracks are not refetched.');
        break;
      }
      failed += 1;
      // Left unfetched deliberately, so a later run retries it. Writing a null
      // here would record "this song has no lyrics" and never ask again.
    }

    if ((i + 1) % 10 === 0 || i === pending.length - 1) {
      const el = (Date.now() - startedAt) / 1000;
      process.stdout.write(`\r${bar(i + 1, pending.length)}  `
        + `${i + 1}/${pending.length}  got ${got}  none ${none}  failed ${failed}  ${el.toFixed(0)}s`);
    }

    if (i < pending.length - 1) await sleep(GAP_MS);
  }

  const el = (Date.now() - startedAt) / 1000;
  console.log(`\n\nDone in ${el.toFixed(0)}s -- ${got} with lyrics, ${none} without, ${failed} failed.`);
  if (!ALL && remaining > pending.length) {
    console.log(`${remaining - pending.length} still to go. Re-run with --all.`);
  }
}

main()
  .catch((err) => { console.error('\n', err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
