/**
 * captureService end-to-end. Creates a throwaway playlist, cleans up after.
 * Run: node tests/capture-service-test.js
 */
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const prisma = require('../src/db/client');
const captureService = require('../src/services/captureService');

// Guard the footgun: capture code must never call the toggle.
const src = fs.readFileSync(require.resolve('../src/services/captureService'), 'utf8');
assert.ok(!/\btoggleLike\b/.test(src), 'captureService must not call toggleLike');

(async () => {
  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  assert.ok(user, 'need an ADMIN user');

  // A song that has a clip, so the playlist can actually hold it.
  const clip = await prisma.clip.findFirst({
    include: { song: { select: { id: true, title: true, artist: true } } },
  });
  assert.ok(clip && clip.song, 'need a clip with a song');

  const playlist = await prisma.playlist.create({
    data: { name: `__capture_test_${Date.now()}`, userId: user.id },
  });

  try {
    await prisma.playlistClip.create({
      data: { playlistId: playlist.id, clipId: clip.id, position: 0 },
    });

    // --- session lifecycle ---
    const { session, token } = await captureService.startSession({
      userId: user.id, playlistId: playlist.id, label: 'test',
    });
    assert.ok(/^[0-9a-f]{48}$/.test(token), 'plaintext token returned once');
    assert.strictEqual(session.playlistId, playlist.id, 'session carries the playlist');

    const live = await captureService.resolveSession(token);
    assert.ok(live && live.id === session.id, 'token resolves');
    assert.strictEqual(await captureService.resolveSession('bogus'), null, 'bad token rejected');

    // --- ingest: exact title match ---
    const r1 = await captureService.ingestText({ session: live, rawText: clip.song.title });
    assert.strictEqual(r1.outcome, 'pending', 'single match awaits approval, not auto-liked');
    assert.ok(r1.matchedClipId, 'proposes a clip');
    assert.strictEqual(
      await prisma.like.count({ where: { playlistId: playlist.id } }), 0,
      'CRITICAL: ingest must not like anything on its own'
    );

    // --- dedupe on rawText ---
    const dup = await captureService.ingestText({ session: live, rawText: clip.song.title });
    assert.strictEqual(dup.outcome, 'duplicate', 'same rawText is deduped');
    assert.strictEqual(
      await prisma.captureEvent.count({ where: { sessionId: session.id } }), 1,
      'dedupe writes no second row'
    );

    // --- unmatched title ---
    const r2 = await captureService.ingestText({ session: live, rawText: '这首歌库里绝对没有zzz' });
    assert.strictEqual(r2.outcome, 'no_match');

    // --- approve applies the like ---
    const ap = await captureService.approveEvent({ userId: user.id, eventId: r1.eventId });
    assert.strictEqual(ap.outcome, 'approved');
    assert.strictEqual(await prisma.like.count({ where: { playlistId: playlist.id } }), 1);

    // approving twice must not toggle the like off
    await captureService.approveEvent({ userId: user.id, eventId: r1.eventId });
    assert.strictEqual(
      await prisma.like.count({ where: { playlistId: playlist.id } }), 1,
      'CRITICAL: re-approve must not remove the like'
    );

    // --- ignore resolves without liking ---
    const ig = await captureService.ignoreEvent({ userId: user.id, eventId: r2.eventId });
    assert.strictEqual(ig.outcome, 'ignored');

    // --- report ---
    const rep = await captureService.getReport({ userId: user.id, sessionId: session.id });
    assert.strictEqual(rep.summary.total, 2);
    assert.strictEqual(rep.unmatched.length, 0, 'ignored no_match leaves the unmatched list');

    // --- ending a session kills the token ---
    await captureService.endSession({ userId: user.id, sessionId: session.id });
    assert.strictEqual(await captureService.resolveSession(token), null, 'ended token is dead');

    console.log('capture-service tests passed');
  } finally {
    await prisma.playlist.delete({ where: { id: playlist.id } }).catch(() => {});
    await prisma.$disconnect();
  }
})();
