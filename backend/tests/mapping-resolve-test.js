/**
 * The lookup chain: mapping -> imported pool -> (external search, not done).
 * Creates throwaway pool rows and cleans up after.
 * Run: node tests/mapping-resolve-test.js
 */
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const prisma = require('../src/db/client');
const { resolveGameSong, TIER } = require('../src/services/mappingResolveService');

// The chain must never call a platform. Step 4 is deliberately absent, and an
// outbound call per captured title is the shape that got this IP throttled.
const src = fs.readFileSync(require.resolve('../src/services/mappingResolveService'), 'utf8');
assert.ok(!/qqSource|neteaseLogin|axios|fetch\(/.test(src),
  'the resolve chain must not reach a platform');

const stamp = Date.now();
const ids = { tracks: [], mappings: [] };

async function track({ title, artist, externalId, durationSec = 200 }) {
  const { titleKey, artistKey } = require('../src/services/songKeyService');
  const t = await prisma.importedTrack.create({
    data: {
      source: 'QQ', externalId, title, artist,
      titleKey: titleKey(title), artistKey: artistKey(artist),
      durationSec, playlistRef: `__test_${stamp}`,
    },
  });
  ids.tracks.push(t.id);
  return t;
}

async function resolve(title, artist) {
  const r = await resolveGameSong({ title, artist });
  if (r.mapping) ids.mappings.push(r.mapping.id);
  return r;
}

(async () => {
  try {
    // --- strong: title and artist agree outright -> approves itself ---
    await track({ title: `__strong_${stamp}`, artist: '周深', externalId: `__S${stamp}` });
    const strong = await resolve(`__strong_${stamp}`, '周深');
    assert.strictEqual(strong.status, 'approved', 'exact agreement self-approves');
    assert.strictEqual(strong.tier, TIER.STRONG);
    assert.strictEqual(strong.mapping.externalId, `__S${stamp}`);

    // --- the pool row is marked as seen, which drives the coverage counter ---
    const seen = await prisma.importedTrack.findFirst({
      where: { externalId: `__S${stamp}` }, select: { matchedAt: true },
    });
    assert.ok(seen.matchedAt, 'claiming a track marks it seen');

    // --- an existing mapping short-circuits the pool ---
    const again = await resolve(`__strong_${stamp}`, '周深');
    assert.strictEqual(again.status, 'approved');
    assert.strictEqual(again.mapping.id, strong.mapping.id, 'reuses, does not duplicate');

    // --- medium: platform bills the artist differently -> playable, queued ---
    await track({ title: `__medium_${stamp}`, artist: '玲花', externalId: `__M${stamp}` });
    const medium = await resolve(`__medium_${stamp}`, '凤凰传奇');
    assert.strictEqual(medium.status, 'pending', 'artist disagreement still plays');
    assert.strictEqual(medium.mapping.approved, false, 'but is not auto-approved');

    // --- weak: a separator guess that DECIDED the match never self-approves ---
    // `_` is this project's separator AND a character inside some real names.
    // What makes a split dangerous is not that it happened but that it changed
    // the answer -- so the case to hold is one where the two sides disagree.
    await track({ title: `__weak_${stamp}`, artist: 'A_B', externalId: `__W${stamp}` });
    const weak = await resolve(`__weak_${stamp}`, 'A_C');
    assert.strictEqual(weak.tier, TIER.WEAK, 'ambiguous separator forces weak');
    assert.strictEqual(weak.mapping.approved, false,
      'CRITICAL: a guessed artist split must never self-approve');
    assert.ok(weak.mapping.note, 'and says why it needs a human');

    // --- ...but an identical separator string is not a guess that matters ---
    // Both sides run through the same splitArtists(), so `A_B` read as two
    // artists is read as the same two on the platform side: the keys agree and
    // the mapping names the right track whether or not the split was correct.
    // Holding these was costing a review of every duet in the catalogue.
    await track({ title: `__dup_${stamp}`, artist: 'A_B', externalId: `__D${stamp}` });
    const duet = await resolve(`__dup_${stamp}`, 'A_B');
    assert.strictEqual(duet.tier, TIER.STRONG, 'identical artist strings agree outright');
    assert.strictEqual(duet.mapping.approved, true,
      'an exact agreement approves itself, separator or not');
    assert.ok(duet.mapping.note, 'and is still flagged, so review can spot-check it');

    // --- nothing in the pool: an ordinary coverage gap, not an error ---
    const miss = await resolve(`__absent_${stamp}_9f3a1b`, '__nobody');
    assert.strictEqual(miss.status, 'unmapped');
    assert.strictEqual(miss.mapping, null);

    // --- alternatives are kept so review can switch without re-searching ---
    await track({ title: `__multi_${stamp}`, artist: '甲', externalId: `__X1${stamp}` });
    await track({ title: `__multi_${stamp}`, artist: '乙', externalId: `__X2${stamp}` });
    const multi = await resolve(`__multi_${stamp}`, '甲');
    assert.ok(multi.candidates.length >= 2, 'both versions offered');
    assert.strictEqual(multi.candidates[0].artist, '甲', 'matching artist ranks first');

    // --- strong needs the EXACT title: another version never self-approves ---
    // The pool is queried loosely (brackets stripped), so 无眠(国语版) finds 无眠.
    // Same artist used to mean strong; now it plays but waits for a human.
    await track({ title: `__ver_${stamp}`, artist: '苏打绿', externalId: `__V${stamp}` });
    const ver = await resolve(`__ver_${stamp}(国语版)`, '苏打绿');
    assert.strictEqual(ver.status, 'pending', 'another version is playable but queued');
    assert.strictEqual(ver.mapping.approved, false, 'CRITICAL: a different version must not self-approve');
    assert.notStrictEqual(ver.tier, TIER.STRONG);
    assert.ok(/歌名/.test(ver.mapping.note || ''), 'and says why');

    // --- both versions in the pool: each game text gets its own version ---
    // And they are two mappings now, which the old loose key made impossible.
    await track({ title: `__vp_${stamp}`, artist: '五月天', externalId: `__VP1${stamp}` });
    await track({ title: `__vp_${stamp}(Live)`, artist: '五月天', externalId: `__VP2${stamp}` });
    const live = await resolve(`__vp_${stamp}(Live)`, '五月天');
    assert.strictEqual(live.mapping.externalId, `__VP2${stamp}`, 'the Live text claims the Live track');
    assert.strictEqual(live.tier, TIER.STRONG, 'exact title and artist self-approve');
    const plain = await resolve(`__vp_${stamp}`, '五月天');
    assert.strictEqual(plain.mapping.externalId, `__VP1${stamp}`, 'the plain text claims the plain track');
    assert.strictEqual(plain.tier, TIER.STRONG);
    assert.notStrictEqual(plain.mapping.id, live.mapping.id, 'two versions, two mappings');

    // --- a case/spacing difference is not an exact title either ---
    await track({ title: `__Case_${stamp} Song`, artist: 'Adele', externalId: `__C${stamp}` });
    const cased = await resolve(`__case_${stamp} song`, 'Adele');
    assert.strictEqual(cased.mapping.approved, false, 'Because Of You vs Because of You waits for a human');

    // --- an exact artist beats an overlapping one ---
    // Otherwise a pool holding both could hand the claim to the looser track and
    // queue a song the pool answers exactly — and 一键解析 must never do that.
    await track({ title: `__ea_${stamp}`, artist: '甲/乙', externalId: `__EA1${stamp}` });
    await track({ title: `__ea_${stamp}`, artist: '甲', externalId: `__EA2${stamp}` });
    const ea = await resolve(`__ea_${stamp}`, '甲');
    assert.strictEqual(ea.mapping.externalId, `__EA2${stamp}`, 'the exact artist is claimed');
    assert.strictEqual(ea.tier, TIER.STRONG);

    // --- the right recording beats the right billing on another version ---
    // Neither approves itself (no row is exact on both halves), but while it
    // waits for review the game's version should play, not a sibling's.
    await track({ title: `__rv_${stamp}`, artist: '甲', externalId: `__RV1${stamp}` });
    await track({ title: `__rv_${stamp}(国语版)`, artist: '甲/乙', externalId: `__RV2${stamp}` });
    const rv = await resolve(`__rv_${stamp}(国语版)`, '甲');
    assert.strictEqual(rv.mapping.externalId, `__RV2${stamp}`, 'the exact title plays, though billed differently');
    assert.strictEqual(rv.mapping.approved, false, 'and still waits for a human');

    // --- past the 25-row cap, the exact-artist track is still in reach ---
    // The pool query is capped and unordered; 一键解析 promises 已确认 for any
    // song the pool answers exactly, so that track must never fall outside it.
    for (let i = 0; i < 30; i += 1) {
      await track({ title: `__cap_${stamp}`, artist: `别人${i}`, externalId: `__CAPX${i}_${stamp}` });
    }
    await track({ title: `__cap_${stamp}`, artist: '目标', externalId: `__CAPT${stamp}` });
    const capped = await resolve(`__cap_${stamp}`, '目标');
    assert.strictEqual(capped.mapping.externalId, `__CAPT${stamp}`, 'exact track found beyond the cap');
    assert.strictEqual(capped.tier, TIER.STRONG);

    console.log('mapping-resolve tests passed');
  } finally {
    if (ids.mappings.length) {
      await prisma.songMapping.deleteMany({ where: { id: { in: ids.mappings } } });
    }
    if (ids.tracks.length) {
      await prisma.importedTrack.deleteMany({ where: { id: { in: ids.tracks } } });
    }
    await prisma.$disconnect();
  }
})();
