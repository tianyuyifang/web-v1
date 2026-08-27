/**
 * Fetch word-level lyrics for the catalogue, once each, and store them.
 *
 * The point of storing is that this runs once per song ever. A karaoke sweep
 * that asked the platform on every playback would put thousands of requests a
 * day on one IP for information that never changes; measured, the same QRC
 * payload came back byte-identical on repeat requests, so there is nothing to
 * refresh.
 *
 * Anonymous throughout. Both endpoints answer without a cookie, which is the
 * reason this is safe to run at all: no user's account is spent on it, and
 * nothing here can be traced to one.
 *
 * Resumable by construction. Every track that has been asked about carries a
 * timestamp whether the answer was yes or no, so a run that is interrupted --
 * or one started a week later after an import -- picks up exactly where it
 * left off rather than re-asking the whole catalogue.
 *
 *   node scripts/backfill-word-lyrics.js                 # dry run, says the plan
 *   node scripts/backfill-word-lyrics.js --apply
 *   node scripts/backfill-word-lyrics.js --apply --limit 200
 *   node scripts/backfill-word-lyrics.js --apply --source QQ
 *   node scripts/backfill-word-lyrics.js --report        # coverage only
 */
require('dotenv').config();

const prisma = require('../src/db/client');
const wordLyrics = require('../src/services/wordLyrics');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const REPORT_ONLY = argv.includes('--report');
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const LIMIT = Number(arg('limit', 0)) || 0;
const SOURCE = (arg('source', '') || '').toUpperCase() || null;

/**
 * How much a payload is allowed to be.
 *
 * A word-level lyric is several times the size of a line-level one -- every
 * syllable carries two numbers -- but it is still text, and anything past this
 * is a sign the parse went wrong rather than a long song.
 */
const MAX_STORED = 120000;

async function report() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT source::text AS source,
           count(*)::int                                              AS total,
           count(*) FILTER (WHERE lyric IS NOT NULL)::int             AS has_line,
           count(*) FILTER (WHERE word_lyric IS NOT NULL)::int        AS has_word,
           count(*) FILTER (WHERE word_lyric_fetched_at IS NOT NULL)::int AS asked
    FROM imported_tracks
    GROUP BY source
    ORDER BY count(*) DESC`);

  const t = rows.reduce((a, r) => ({
    total: a.total + r.total,
    has_line: a.has_line + r.has_line,
    has_word: a.has_word + r.has_word,
    asked: a.asked + r.asked,
  }), { total: 0, has_line: 0, has_word: 0, asked: 0 });

  const pct = (n, d) => (d ? `${(n / d * 100).toFixed(1)}%` : '—');

  console.log('\n════ 逐字歌词覆盖率 ════\n');
  console.log('  音源       曲目数   有整句   已询问   有逐字   逐字占比');
  console.log('  ─────────────────────────────────────────────────────');
  for (const r of rows) {
    console.log(`  ${r.source.padEnd(9)} ${String(r.total).padStart(6)}`
      + `   ${String(r.has_line).padStart(6)}`
      + `   ${String(r.asked).padStart(6)}`
      + `   ${String(r.has_word).padStart(6)}`
      + `   ${pct(r.has_word, r.asked).padStart(8)}`);
  }
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  ${'合计'.padEnd(8)} ${String(t.total).padStart(6)}`
    + `   ${String(t.has_line).padStart(6)}`
    + `   ${String(t.asked).padStart(6)}`
    + `   ${String(t.has_word).padStart(6)}`
    + `   ${pct(t.has_word, t.asked).padStart(8)}`);

  const remaining = t.total - t.asked;
  if (remaining > 0) {
    const mins = Math.ceil(remaining * (wordLyrics.MIN_GAP_MS / 1000) / 60);
    console.log(`\n  还没问过：${remaining} 首（约 ${mins} 分钟）`);
  } else {
    console.log('\n  全部问过了。');
  }
  // "asked but got nothing" is the honest denominator for how much of the
  // catalogue a sweep will actually work on.
  console.log(`  问过但没有逐字：${t.asked - t.has_word} 首`);
}

async function main() {
  if (REPORT_ONLY) return report();

  const where = {
    // Never asked. A track asked once and refused is not asked again: the
    // platform does not grow lyrics later, and re-asking is what turns a
    // one-off backfill into recurring traffic.
    wordLyricFetchedAt: null,
    ...(SOURCE ? { source: SOURCE } : { source: { in: ['QQ', 'NETEASE'] } }),
  };

  const pending = await prisma.importedTrack.count({ where });
  const total = await prisma.importedTrack.count();
  console.log(`\n曲库 ${total} 首，还没问过 ${pending} 首`
    + (SOURCE ? `（只看 ${SOURCE}）` : '（只问 QQ 和网易云）'));

  if (!pending) { console.log('没有要处理的。\n'); return report(); }

  const take = LIMIT || pending;
  const mins = Math.ceil(take * (wordLyrics.MIN_GAP_MS / 1000) / 60);
  console.log(`本次处理 ${take} 首，限速 ${wordLyrics.MIN_GAP_MS}ms，预计 ${mins} 分钟`);

  if (!APPLY) {
    console.log('\n这是预演。加 --apply 才会真正请求和写入。\n');
    return report();
  }

  const tracks = await prisma.importedTrack.findMany({
    where,
    select: { id: true, source: true, externalId: true, title: true, artist: true, durationSec: true },
    take,
    orderBy: { createdAt: 'asc' },
  });

  let got = 0; let none = 0; let failed = 0;
  const started = Date.now();

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    let lines = null;
    try {
      lines = await wordLyrics.fetch(t);
    } catch (err) {
      failed += 1;
      // Left unmarked on purpose: a failed request is not an answer, so the
      // next run tries it again rather than recording "this song has none".
      if (failed <= 5) console.log(`\n  请求失败 ${t.title}：${err.message}`);
      continue;
    }

    const payload = lines ? JSON.stringify(lines) : null;
    const tooBig = payload && payload.length > MAX_STORED;

    await prisma.importedTrack.update({
      where: { id: t.id },
      data: {
        wordLyric: tooBig ? null : payload,
        wordLyricFetchedAt: new Date(),
      },
    });

    if (payload && !tooBig) got += 1; else none += 1;

    if ((i + 1) % 25 === 0 || i === tracks.length - 1) {
      const done = i + 1;
      const rate = (Date.now() - started) / done;
      const left = Math.ceil((tracks.length - done) * rate / 60000);
      process.stdout.write(`\r  ${done}/${tracks.length}  有 ${got}  无 ${none}`
        + `  失败 ${failed}  剩约 ${left} 分钟   `);
    }
  }

  console.log(`\n\n完成：有逐字 ${got}，没有 ${none}，请求失败 ${failed}`);
  if (failed) console.log('（失败的没有标记，下次运行会重试）');
  await report();
}

main()
  .catch((err) => { console.error('\n出错：', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
