/**
 * Put a handful of local songs into the 唱卡 catalogue.
 *
 * 唱卡 resolves only against imported_tracks. The local library (songs) is a
 * different table serving playlists, clips and 歌 P, and the two do not meet --
 * so a song we own outright is unplayable in 唱卡 until it has a row here.
 *
 * This is deliberately a narrow bridge, not a merge. The local library holds
 * thousands of songs; copying all of them would put every one of them behind
 * this server's egress and drown the pool's ranking in near-duplicates. Named
 * songs only, chosen by hand.
 *
 * What a row costs, and there are two costs, not one:
 *
 * Egress. The audio streams from here rather than from a CDN, 1.6-2.6MB a play
 * for the songs added so far. Fine for a handful; the reason not to do this in
 * bulk.
 *
 * Reach. A row here is offered as a candidate to every 唱卡 listener, not only
 * to editors -- candidatesFor is deliberately open so a singer can choose
 * between recordings -- and a candidate can be previewed. So adding a row is
 * also deciding that every member may stream that song on demand. That is the
 * intent for songs picked for 唱卡, and it is a poor way to reach the whole
 * local library: bulk-importing would silently make the lot of it streamable
 * from the mapping routes, which is a bigger decision than it looks.
 *
 * Lyrics are NOT copied. The lyrics route reads them live from songs for LOCAL,
 * so editing a local lyric shows up in 唱卡 immediately -- measured at 0.02ms
 * more than reading a copy, which buys nothing.
 *
 *   node scripts/import-local-to-pool.js            # dry run, the default list
 *   node scripts/import-local-to-pool.js --apply
 *   node scripts/import-local-to-pool.js --song "情路放我过|詹雅雯" --apply
 *
 * The artist is checked, not merely recorded: it is compared through
 * artistKey, so 向蕙玲/陈随意 and 向蕙玲_陈随意 are the same two people.
 *
 * Idempotent per recording: skipped only if THIS local song (LOCAL + its id)
 * is already pooled, which is the table's real unique key. It does NOT skip on
 * title — a QQ or NetEase "爱是不保留" already in the pool is a different
 * recording from a LOCAL one the admin downloaded, and both should coexist, the
 * way 唱卡 keeps every version of a title. (An earlier version skipped on title
 * alone and wrongly refused an exclusive whose platform namesake was present.)
 */
require('dotenv').config();

const prisma = require('../src/db/client');
const { titleKey, artistKey } = require('../src/services/songKeyService');

/**
 * Which songs to bridge, as `--song "title|artist"` repeated.
 *
 * On the command line rather than only in this list, because the list is a
 * record of one afternoon's picks and every later batch had to edit the file
 * to reuse the script -- which puts a one-off shopping list into version
 * control and makes the script's history a log of what was imported when.
 * The default below is kept so the original batch stays reproducible.
 */
function fromArgv() {
  const out = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--song' || !argv[i + 1]) continue;
    const [title, artist] = argv[i + 1].split('|');
    if (!title || !artist) {
      console.error(`--song 要写成 "歌名|歌手"，收到的是：${argv[i + 1]}`);
      process.exit(1);
    }
    out.push([title.trim(), artist.trim()]);
  }
  return out;
}

/** Exact local titles. Matched on title alone, then checked against the artist. */
const DEFAULT_WANTED = [
  ['不重逢', '华晨宇'],
  ['黑白艺术家', '华晨宇'],
  ['怪诞心理学', '华晨宇'],
  ['飞行模式', '华晨宇'],
  ['人之爱', '华晨宇'],
  ['当全世界忘了我', '华晨宇'],
  ['温暖的房子', '华晨宇'],
  ['忒修斯的船', '华晨宇'],
  ['小镇里的花', '华晨宇'],
  ['晨光里有你', '华晨宇'],
  ['黑夜问白天', '林俊杰'],
];

const argvSongs = fromArgv();
const WANTED = argvSongs.length ? argvSongs : DEFAULT_WANTED;

const APPLY = process.argv.includes('--apply');

async function main() {
  const plan = [];
  const skipped = [];
  const problems = [];

  for (const [title, artist] of WANTED) {
    const songs = await prisma.song.findMany({
      where: { title },
      select: { id: true, title: true, artist: true, duration: true },
    });

    if (!songs.length) { problems.push([title, '本地曲库里没有这首歌']); continue; }

    // The artist is part of the request, so use it to choose rather than only
    // to verify. Two songs called 手中沙 by different people are not ambiguous
    // when one of them was named; refusing them both made the caller edit the
    // catalogue to work around a question they had already answered.
    const wanted = artistKey(artist);
    const byArtist = songs.filter((x) => artistKey(x.artist) === wanted);

    if (byArtist.length > 1) {
      problems.push([title, `本地有 ${byArtist.length} 首「${title} — ${artist}」，需要人工指定`]);
      continue;
    }
    if (!byArtist.length) {
      problems.push([title, `歌手不符：期望「${artist}」，本地是「`
        + songs.map((x) => x.artist).join('、') + '」']);
      continue;
    }
    const song = byArtist[0];

    // Skip only if THIS recording is already pooled — the pool row keyed on
    // (LOCAL, this song's id), which is the table's real unique key. Matching
    // on title alone was wrong: an exclusive is a LOCAL recording the admin
    // downloaded and vouched for, and its id can never collide with a QQ or
    // NetEase version of the same title, so a platform "爱是不保留" in the pool
    // is no reason to skip the LOCAL 关心妍 one. Different source, different
    // song — they coexist, which is exactly what 唱卡 wants.
    const existing = await prisma.importedTrack.findUnique({
      where: { source_externalId: { source: 'LOCAL', externalId: song.id } },
      select: { source: true },
    });
    if (existing) {
      skipped.push([title, `已在池（${title} — ${artist}）`]);
      continue;
    }

    plan.push(song);
  }

  console.log(`要导入 ${plan.length} 首：`);
  for (const s of plan) {
    console.log(`  ${s.title.padEnd(20)} ${s.artist.padEnd(16)} ${s.duration}s  ${s.id}`);
  }
  if (skipped.length) {
    console.log(`\n跳过 ${skipped.length} 首（唱卡曲库里已有）：`);
    skipped.forEach(([t, who]) => console.log(`  ${t.padEnd(20)} ${who}`));
  }
  if (problems.length) {
    console.log(`\n⚠ ${problems.length} 首有问题，未处理：`);
    problems.forEach(([t, why]) => console.log(`  ${t.padEnd(20)} ${why}`));
  }

  if (!APPLY) {
    console.log('\n这是预演。加 --apply 才会真正写入。');
    return;
  }
  if (!plan.length) { console.log('\n没有要写入的。'); return; }

  let written = 0;
  for (const s of plan) {
    // externalId is the local song's own uuid: that is what the preview and
    // lyrics routes look it up by, so the pool row points back at the real song
    // rather than duplicating it.
    await prisma.importedTrack.upsert({
      where: { source_externalId: { source: 'LOCAL', externalId: s.id } },
      update: {
        title: s.title,
        artist: s.artist,
        titleKey: titleKey(s.title),
        artistKey: artistKey(s.artist),
        durationSec: s.duration ?? null,
      },
      create: {
        source: 'LOCAL',
        externalId: s.id,
        title: s.title,
        artist: s.artist,
        titleKey: titleKey(s.title),
        artistKey: artistKey(s.artist),
        durationSec: s.duration ?? null,
        // Traceable back to this script rather than to a platform playlist.
        playlistRef: 'local:hand-picked',
        // Left unseen: the game has not named it yet, and the coverage counter
        // should say so. It moves on its own the first time it turns up.
        matchedAt: null,
      },
    });
    written += 1;
  }
  console.log(`\n写入 ${written} 首。游戏里出现时会自动匹配，界面显示「独家」。`);
}

main()
  .catch((err) => { console.error('\n', err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
