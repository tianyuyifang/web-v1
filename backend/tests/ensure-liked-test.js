/**
 * ensureLiked safety tests.
 *
 * These guard the two ways automation could silently destroy data:
 *   1. Repeat capture of the same song must not flip the like off.
 *   2. A like made by a human must never be revoked by automation.
 *
 * Creates a throwaway playlist and cleans it up. Requires DATABASE_URL.
 * Run: node tests/ensure-liked-test.js
 */
require('dotenv').config();
const assert = require('assert');
const prisma = require('../src/db/client');
const likeService = require('../src/services/likeService');

(async () => {
  assert.strictEqual(typeof likeService.ensureLiked, 'function', 'ensureLiked is exported');

  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  assert.ok(user, 'need an ADMIN user to run this test');

  const clip = await prisma.clip.findFirst({ select: { id: true } });
  assert.ok(clip, 'need at least one clip in the DB');

  const playlist = await prisma.playlist.create({
    data: { name: `__ensure_liked_test_${Date.now()}`, userId: user.id },
  });

  try {
    const count = () => prisma.like.count({ where: { playlistId: playlist.id } });

    // --- 1. first call creates the like ---
    let r = await likeService.ensureLiked(user.id, playlist.id, clip.id);
    assert.deepStrictEqual(r, { liked: true, alreadyLiked: false }, 'first call creates');
    assert.strictEqual(await count(), 1);

    // --- 2. repeat calls are no-ops, NOT toggles ---
    for (let i = 0; i < 5; i++) {
      r = await likeService.ensureLiked(user.id, playlist.id, clip.id);
      assert.deepStrictEqual(r, { liked: true, alreadyLiked: true }, `repeat ${i + 1} is a no-op`);
    }
    assert.strictEqual(
      await count(), 1,
      'CRITICAL: repeat ensureLiked must not toggle the like off'
    );

    // --- 3. must not revoke a like a human made ---
    // Simulate: user unlikes by hand, then likes by hand, then capture fires.
    await likeService.toggleLike(user.id, playlist.id, clip.id);   // human unlikes
    assert.strictEqual(await count(), 0, 'toggleLike still removes (UI behaviour intact)');
    await likeService.toggleLike(user.id, playlist.id, clip.id);   // human likes again
    assert.strictEqual(await count(), 1);

    await likeService.ensureLiked(user.id, playlist.id, clip.id);  // capture fires
    assert.strictEqual(
      await count(), 1,
      "CRITICAL: capture must not revoke a human's like"
    );

    // --- 4. toggleLike is unchanged for UI use ---
    const t = await likeService.toggleLike(user.id, playlist.id, clip.id);
    assert.deepStrictEqual(t, { liked: false }, 'toggleLike still toggles off');
    assert.strictEqual(await count(), 0);

    console.log('ensure-liked tests passed');
  } finally {
    await prisma.playlist.delete({ where: { id: playlist.id } }).catch(() => {});
    await prisma.$disconnect();
  }
})();
