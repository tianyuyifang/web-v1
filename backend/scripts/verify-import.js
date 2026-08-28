/**
 * Roll call after an import: is everything we asked for actually in the pool?
 *
 * This is the only check worth running after import-mapping.js, and the reason
 * is narrow. The import can come up short without failing: a paged fetch that
 * stops early, a platform that returns fewer tracks than it claims, a timeout
 * on the last batch. None of those raise an error, so "the script finished" is
 * not evidence that the songs are there.
 *
 * What this deliberately does NOT check, because each looks like diligence and
 * is actually noise:
 *
 *   Duplicates — the database has UNIQUE (source, external_id). A duplicate
 *   cannot be written, so counting them always returns zero. That zero says
 *   nothing about whether the import was any good.
 *
 *   Same title + same artist — this is what 唱卡 is for. Two different songs
 *   share a name and a singer all the time (live, studio, cover), and the
 *   singer wants that particular version. The same song held on both QQ and
 *   NetEase is deliberate too. Reporting these trains you to ignore the report.
 *
 *   post-import-audit.js — that one reads the songs table (local mp3s). This
 *   flow writes imported_tracks. Running it after an import checks a table the
 *   import never touched.
 *
 * Usage:
 *   node scripts/verify-import.js --platform qq      --playlist 9768124348
 *   node scripts/verify-import.js --platform netease --playlist 18307905302
 *   node scripts/verify-import.js --local '手中沙|大王'
 *
 * Read-only: it never writes. Exit code 1 if anything is missing, so it can
 * gate a scripted run.
 */
require('dotenv').config();
const prisma = require('../src/db/client');
const qq = require('../src/services/sources/qqSource');
const netease = require('../src/services/sources/neteaseLogin');
const { artistKey } = require('../src/services/songKeyService');

const argv = process.argv;
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const PLATFORM = (arg('platform') || '').toLowerCase();
const PLAYLIST = arg('playlist');
const LOCAL = arg('local');

const PLATFORMS = {
  qq: { label: 'QQ', api: qq, env: 'QQ_COOKIE', source: 'QQ' },
  netease: { label: '网易云', api: netease, env: 'NETEASE_COOKIE', source: 'NETEASE' },
};

function bail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Same order of preference as the importer: stored credential first. */
async function resolveCookie(plat) {
  if (process.env[plat.env]) return process.env[plat.env];
  const credentials = require('../src/services/musicCredentialService');
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN' },
    select: { id: true },
    orderBy: { username: 'asc' },
  });
  for (const a of admins) {
    const cred = await credentials.getCredential(a.id, PLATFORM).catch(() => null);
    if (cred && cred.cookie) return cred.cookie;
  }
  return null;
}

async function verifyPlaylist() {
  const plat = PLATFORMS[PLATFORM];
  if (!plat) bail('--platform 只能是 qq 或 netease');
  if (!PLAYLIST) bail('要给 --playlist <id>');

  const cookie = await resolveCookie(plat);
  if (!cookie) bail(`没有 ${plat.label} 凭证：在账号页连接，或设 ${plat.env}`);

  console.log(`\n核对 ${plat.label} 歌单 ${PLAYLIST} …\n`);
  let playlist;
  try {
    playlist = await plat.api.getPlaylist(PLAYLIST, { cookie });
  } catch (err) {
    bail(`拉取失败 (${err.code || 'unknown'}): ${err.message}`);
  }

  const { title, total, tracks } = playlist;
  console.log(`  「${title}」`);

  // The platform's own count against what the pager actually returned. A gap
  // here means the import was short before the database was ever involved,
  // which is a different fix from a song failing to write.
  const short = typeof total === 'number' && total > tracks.length;
  console.log(`  平台说 ${total} 首，实际拉到 ${tracks.length} 首`
    + (short ? `   ⚠ 少 ${total - tracks.length} 首` : '   ✓'));

  const ids = tracks.map((t) => String(t.externalId));
  const rows = await prisma.importedTrack.findMany({
    where: { source: plat.source, externalId: { in: ids } },
    select: { externalId: true },
  });
  const have = new Set(rows.map((r) => r.externalId));
  const missing = tracks.filter((t) => !have.has(String(t.externalId)));

  console.log(`  池子里有 ${have.size} / ${tracks.length}`
    + (missing.length ? `   ✗ 缺 ${missing.length} 首` : '   ✓ 全在'));

  if (missing.length) {
    console.log('\n── 缺的 ──');
    missing.slice(0, 40).forEach((t) => console.log(`   ${t.title} - ${t.artist}   ${t.externalId}`));
    if (missing.length > 40) console.log(`   … 还有 ${missing.length - 40} 首`);
  }

  return missing.length === 0 && !short;
}

async function verifyLocal() {
  // "标题|歌手", the same shape import-local-to-pool.js takes, so a song can be
  // checked with the argument it was added with.
  const [title, artist] = LOCAL.split('|').map((s) => (s || '').trim());
  if (!title || !artist) bail("--local 要写成 '标题|歌手'");

  const songs = await prisma.song.findMany({
    where: { title },
    select: { id: true, title: true, artist: true },
  });
  const want = artistKey(artist);
  const match = songs.filter((s) => artistKey(s.artist) === want);

  console.log(`\n核对本地独家：${title} - ${artist}\n`);
  if (!match.length) {
    console.log(`  ✗ 本地曲库里找不到（同名的有 ${songs.length} 首）`);
    return false;
  }
  if (match.length > 1) {
    console.log(`  ✗ 本地有 ${match.length} 首同名同歌手，说不清是哪首`);
    return false;
  }

  const song = match[0];
  const row = await prisma.importedTrack.findFirst({
    where: { source: 'LOCAL', externalId: song.id },
    select: { id: true },
  });
  console.log(row ? `  ✓ 在池子里   ${song.id}` : `  ✗ 不在池子里   ${song.id}`);
  return Boolean(row);
}

async function main() {
  let ok;
  if (LOCAL) ok = await verifyLocal();
  else ok = await verifyPlaylist();

  console.log(ok ? '\n✓ 都进去了\n' : '\n✗ 有缺的，见上\n');
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
