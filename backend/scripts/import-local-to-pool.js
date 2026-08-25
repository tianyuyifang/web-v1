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
 *   node scripts/import-local-to-pool.js            # dry run, prints the plan
 *   node scripts/import-local-to-pool.js --apply
 *
 * Idempotent: a title already in the pool is skipped and named, whatever its
 * source. That is the point -- a QQ or NetEase version already there is the
 * version 唱卡 has been using, and quietly adding a second one would change
 * which recording a song resolves to without anyone asking for it.
 */
require('dotenv').config();

const prisma = require('../src/db/client');
const { titleKey, artistKey } = require('../src/services/songKeyService');

/** Exact local titles. Matched on title alone, then checked against the artist. */
const WANTED = [
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
    if (songs.length > 1) { problems.push([title, `本地有 ${songs.length} 首同名，需要人工指定`]); continue; }

    const song = songs[0];
    if (artistKey(song.artist) !== artistKey(artist)) {
      problems.push([title, `歌手不符：期望「${artist}」，本地是「${song.artist}」`]);
      continue;
    }

    // Anything already in the pool wins, whatever its source -- see the header.
    const existing = await prisma.importedTrack.findMany({
      where: { titleKey: titleKey(title) },
      select: { source: true, artist: true },
    });
    if (existing.length) {
      skipped.push([title, existing.map((e) => `${e.artist}(${e.source})`).join(', ')]);
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
