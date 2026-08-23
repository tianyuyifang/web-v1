/**
 * Import a platform playlist into imported_tracks, the pool that game songs
 * are later matched against.
 *
 * Where the data comes from matters. A playlist you curated is a set of tracks
 * you already vouch for, so importing one is far more reliable than searching
 * per song and hoping the top hit is right — and it costs a handful of
 * requests instead of thousands.
 *
 * This stores metadata only: mid, title, artist, duration, and whether the
 * track needs VIP. It never resolves a playback URL, so a 3,000-song import is
 * four paged requests, all of them subject to the usual pacing and concurrency
 * limits. That is less traffic than opening the web player once.
 *
 * Nothing here writes a song_mapping. An imported track has no game-side key
 * yet — the game may call the same song something else, or never play it at
 * all — so matching is a separate, reviewable step.
 *
 * Usage:
 *   QQ_COOKIE='...' node scripts/import-mapping.js --playlist 9669986815
 *   QQ_COOKIE='...' node scripts/import-mapping.js --playlist 9669986815 --apply
 *
 * Dry run by default: it reports what would change and writes nothing.
 */
require('dotenv').config();
const prisma = require('../src/db/client');
const qq = require('../src/services/sources/qqSource');
const netease = require('../src/services/sources/neteaseLogin');
const breaker = require('../src/services/musicSourceBreaker');
const { titleKey, artistKey, isSeparatorAmbiguous } = require('../src/services/songKeyService');

const argv = process.argv;
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const PLATFORM = (arg('platform', 'qq') || 'qq').toLowerCase();
const PLAYLIST = arg('playlist');
const APPLY = has('apply');

function bail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Group rows by the key they will be stored under, to expose collisions. */
function summarise(tracks) {
  const byKey = new Map();
  const ambiguous = [];
  const noArtist = [];

  for (const t of tracks) {
    const tk = titleKey(t.title);
    const ak = artistKey(t.artist);
    if (!ak) noArtist.push(t);
    // Every separator we split on also occurs inside real artist names
    // (AC/DC, Simon & Garfunkel). Flagging them here means review can look at
    // the handful that are genuinely ambiguous instead of trusting a guess.
    if (isSeparatorAmbiguous(t.artist)) ambiguous.push(t);

    const key = `${tk}|${ak}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }

  return {
    byKey,
    ambiguous,
    noArtist,
    duplicates: [...byKey.entries()].filter(([, rows]) => rows.length > 1),
    vipCount: tracks.filter((t) => t.vipOnly).length,
  };
}

/** Which platform this run is talking to, and where its cookie comes from. */
const PLATFORMS = {
  qq: { source: 'QQ', label: 'QQ', env: 'QQ_COOKIE', api: qq },
  netease: { source: 'NETEASE', label: '网易云', env: 'NETEASE_COOKIE', api: netease },
};

(async () => {
  if (!PLAYLIST) bail('Which playlist? e.g. --playlist 9669986815');
  const plat = PLATFORMS[PLATFORM];
  if (!plat) {
    bail(`Unknown --platform ${PLATFORM}. One of: ${Object.keys(PLATFORMS).join(', ')}`);
  }
  const SOURCE = plat.source;

  const cookie = process.env[plat.env];
  if (!cookie) {
    bail(`Set ${plat.env}. It is read from the environment so it never lands in a file:\n`
      + `  ${plat.env}='…' node scripts/import-mapping.js --platform ${PLATFORM} --playlist ${PLAYLIST}`);
  }

  console.log(`\nFetching ${plat.label} playlist ${PLAYLIST} …`);
  console.log('(batched, so a few thousand songs cost a handful of requests)\n');

  const started = Date.now();
  let playlist;
  try {
    playlist = await plat.api.getPlaylist(PLAYLIST, { cookie });
  } catch (err) {
    // Say which kind of failure this is, because the fixes are unrelated:
    // a stale cookie needs replacing, a breaker trip needs waiting out.
    if (err.code === 'SOURCE_UNAVAILABLE') {
      bail(`音源暂停中，约 ${Math.ceil((err.retryAfterMs || 0) / 60000)} 分钟后再试`);
    }
    bail(`拉取失败 (${err.code || 'unknown'}): ${err.message}`);
  }

  const { title, total, tracks } = playlist;
  console.log(`  "${title}" — ${tracks.length} tracks fetched of ${total} reported`);
  console.log(`  took ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  if (total != null && tracks.length < total) {
    console.log(`  ⚠ fetched fewer than reported (${tracks.length} < ${total}).`);
    console.log('    Raise --maxSongs, or the playlist changed while paging.\n');
  }
  if (!tracks.length) bail('Nothing to import.');

  const stats = summarise(tracks);

  // --- what is already stored ------------------------------------------------
  const existing = await prisma.importedTrack.findMany({
    where: { source: SOURCE, externalId: { in: tracks.map((t) => t.externalId) } },
  });
  const existingById = new Map(existing.map((r) => [r.externalId, r]));

  const toCreate = [];
  const toUpdate = [];
  const unchanged = [];
  for (const t of tracks) {
    const prev = existingById.get(t.externalId);
    if (!prev) { toCreate.push(t); continue; }
    const differs = prev.title !== t.title
      || prev.artist !== t.artist
      || prev.durationSec !== t.durationSec
      || prev.vipOnly !== t.vipOnly;
    (differs ? toUpdate : unchanged).push(t);
  }

  console.log('── what this would do ──────────────────────────────');
  console.log(`  new            ${String(toCreate.length).padStart(5)}`);
  console.log(`  updated        ${String(toUpdate.length).padStart(5)}   (already imported, details changed)`);
  console.log(`  unchanged      ${String(unchanged.length).padStart(5)}`);
  console.log('');
  console.log(`  needs VIP      ${String(stats.vipCount).padStart(5)}   ${(stats.vipCount / tracks.length * 100).toFixed(0)}% of the playlist`);
  console.log(`  ambiguous artist ${String(stats.ambiguous.length).padStart(3)}   split on a single separator — review decides`);
  if (stats.noArtist.length) console.log(`  no artist      ${String(stats.noArtist.length).padStart(5)}`);
  console.log('');

  if (stats.duplicates.length) {
    // Two rows under one key are either the same recording listed twice, or
    // genuinely different versions — a live take and a studio one. Only the
    // second kind needs a decision, since a mapping holds one id per key, so
    // they are separated here rather than lumped together as "duplicates".
    const spread = (rows) => {
      const d = rows.map((r) => r.durationSec).filter((x) => x != null);
      return d.length > 1 ? Math.max(...d) - Math.min(...d) : 0;
    };
    const sameRecording = stats.duplicates.filter(([, r]) => spread(r) <= 3);
    const differentTakes = stats.duplicates.filter(([, r]) => spread(r) > 3);

    console.log(`── ${stats.duplicates.length} title+artist collisions ───────────────`);
    console.log(`   ${sameRecording.length} look like the same recording listed twice (durations match)`);
    console.log(`   ${differentTakes.length} are different versions — review picks which one plays`);
    console.log('');
    for (const [key, rows] of differentTakes.slice(0, 10)) {
      console.log(`   ${key.replace('|', ' — ')}`);
      rows.forEach((r) => console.log(`      ${r.externalId}  ${r.durationSec}s`));
    }
    if (differentTakes.length > 10) console.log(`   … and ${differentTakes.length - 10} more`);
    console.log('');
  }

  if (stats.ambiguous.length) {
    console.log('── sample of ambiguous artists ─────────────────────');
    [...new Set(stats.ambiguous.map((t) => t.artist))].slice(0, 8)
      .forEach((a) => console.log(`   ${a}`));
    console.log('');
  }

  if (toUpdate.length) {
    console.log('── sample of changes to existing rows ──────────────');
    for (const t of toUpdate.slice(0, 8)) {
      const prev = existingById.get(t.externalId);
      const diffs = [];
      if (prev.title !== t.title) diffs.push(`title "${prev.title}" → "${t.title}"`);
      if (prev.artist !== t.artist) diffs.push(`artist "${prev.artist}" → "${t.artist}"`);
      if (prev.durationSec !== t.durationSec) diffs.push(`${prev.durationSec}s → ${t.durationSec}s`);
      if (prev.vipOnly !== t.vipOnly) diffs.push(`vip ${prev.vipOnly} → ${t.vipOnly}`);
      console.log(`   ${t.title} — ${diffs.join(', ')}`);
    }
    if (toUpdate.length > 8) console.log(`   … and ${toUpdate.length - 8} more`);
    console.log('');
  }

  if (!APPLY) {
    console.log('Dry run — nothing was written. Re-run with --apply to commit.\n');
    await prisma.$disconnect();
    return;
  }

  console.log('Writing …');
  let written = 0;
  // Chunked so one oversized statement cannot stall the database, and so
  // progress is visible on a long import.
  const CHUNK = 200;
  for (let i = 0; i < tracks.length; i += CHUNK) {
    const slice = tracks.slice(i, i + CHUNK);
    await prisma.$transaction(slice.map((t) => prisma.importedTrack.upsert({
      where: { source_externalId: { source: SOURCE, externalId: t.externalId } },
      create: {
        source: SOURCE,
        externalId: t.externalId,
        title: t.title,
        artist: t.artist,
        titleKey: titleKey(t.title),
        artistKey: artistKey(t.artist),
        durationSec: t.durationSec,
        album: t.album,
        vipOnly: t.vipOnly,
        playlistRef: String(PLAYLIST),
      },
      // matchedAt is deliberately not touched: a re-import refreshes the
      // platform's details without forgetting that a game song already
      // claimed this track.
      update: {
        title: t.title,
        artist: t.artist,
        titleKey: titleKey(t.title),
        artistKey: artistKey(t.artist),
        durationSec: t.durationSec,
        album: t.album,
        vipOnly: t.vipOnly,
        playlistRef: String(PLAYLIST),
      },
    })));
    written += slice.length;
    process.stdout.write(`\r  ${written}/${tracks.length}`);
  }

  const poolSize = await prisma.importedTrack.count();
  console.log(`\n\nDone. ${written} tracks written; pool now holds ${poolSize}.\n`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nFailed:', err.message);
  if (breaker.status(PLATFORM).open) console.error('(the circuit breaker is open — wait it out)');
  await prisma.$disconnect();
  process.exit(1);
});
