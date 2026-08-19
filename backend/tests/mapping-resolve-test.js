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

    // --- weak: a load-bearing separator guess never self-approves ---
    // `_` is this project's separator AND a character inside some real names,
    // so a split that decided the match must be seen by a human.
    await track({ title: `__weak_${stamp}`, artist: 'A_B', externalId: `__W${stamp}` });
    const weak = await resolve(`__weak_${stamp}`, 'A_B');
    assert.strictEqual(weak.tier, TIER.WEAK, 'ambiguous separator forces weak');
    assert.strictEqual(weak.mapping.approved, false,
      'CRITICAL: a guessed artist split must never self-approve');
    assert.ok(weak.mapping.note, 'and says why it needs a human');

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
