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

    // --- starting a run ends the user's previous one ---
    // The capture client holds a single token from whenever it last paired.
    // If an old run stayed alive it kept posting there, liking songs in a
    // playlist the user had left while the panel reported a dead client.
    // Checked in its own scope so the rest of this test keeps using `live`.
    {
      const second = await captureService.startSession({
        userId: user.id, playlistId: playlist.id, label: 'second',
      });
      assert.strictEqual(
        await captureService.resolveSession(token), null,
        'CRITICAL: the earlier run must stop accepting posts'
      );
      assert.ok(
        await captureService.resolveSession(second.token),
        'the new run is the live one'
      );
      // Restore the original run so the assertions below still exercise it.
      await captureService.endSession({ userId: user.id, sessionId: second.session.id });
      await prisma.captureSession.update({
        where: { id: session.id },
        data: { endedAt: null },
      });
      assert.ok(await captureService.resolveSession(token), 'original run restored for the rest of the test');
    }

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
    // Must not begin with anything that could be a real title: the loose
    // branch prefix-matches, and the old value "这首歌库里绝对没有zzz" started
    // with 萧敬腾's "这首歌", so this passed locally and failed on the
    // production library.
    const r2 = await captureService.ingestText({
      session: live,
      rawText: 'zzqqxxjjzz-no-such-song-9f3a1b',
    });
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

    // --- live (唱卡) mode ---
    // A live run has no playlist at all. The point of these assertions is that
    // the playlist flow above and this one share a table without sharing a
    // code path: a live session must never be able to like anything.
    const liveRun = await captureService.startSession({
      userId: user.id, mode: 'live', label: '__live_test',
    });
    assert.strictEqual(liveRun.session.playlistId, null, 'live run holds no playlist');
    assert.strictEqual(liveRun.session.mode, 'live');

    const liveSession = await captureService.resolveSession(liveRun.token);
    assert.ok(liveSession, 'live token resolves');
    assert.strictEqual(liveSession.mode, 'live', 'mode survives the token round trip');

    const key = require('../src/services/songKeyService').songKey(
      `__live_title_${Date.now()}`, '__live_artist'
    );
    const mapping = await prisma.songMapping.create({
      data: {
        ...key, source: 'QQ', externalId: '__LIVE_TEST_MID', platformTitle: 'T',
        platformArtist: 'A', durationSec: 180, approved: true, origin: 'search',
      },
    });

    try {
      const hit = await captureService.ingestLive({
        session: liveSession, rawText: `${key.rawTitle}-${key.rawArtist}`,
      });
      assert.strictEqual(hit.outcome, 'resolved');
      assert.strictEqual(hit.mapping.externalId, '__LIVE_TEST_MID');

      // Same title again is the common case, not an error: a title sits on
      // screen for seconds and is read over and over.
      const again = await captureService.ingestLive({
        session: liveSession, rawText: `${key.rawTitle}-${key.rawArtist}`,
      });
      assert.strictEqual(again.outcome, 'duplicate');

      const miss = await captureService.ingestLive({
        session: liveSession, rawText: '__live_no_such_song_9f3a1b-__nobody',
      });
      assert.strictEqual(miss.outcome, 'unmapped');
      assert.strictEqual(miss.mapping, null);

      // An unapproved mapping still plays — a round lasts seconds, so waiting
      // for a reviewer would mean the song is never available when it is
      // wanted. It is flagged rather than withheld.
      await prisma.songMapping.update({ where: { id: mapping.id }, data: { approved: false } });
      const unapprovedRun = await captureService.startSession({ userId: user.id, mode: 'live' });
      const unapprovedSession = await captureService.resolveSession(unapprovedRun.token);
      const guarded = await captureService.ingestLive({
        session: unapprovedSession, rawText: `${key.rawTitle}-${key.rawArtist}`,
      });
      assert.strictEqual(guarded.outcome, 'resolved', 'unapproved mappings still play');
      assert.strictEqual(guarded.mapping.approved, false, 'but are marked unconfirmed');
      await prisma.captureEvent.deleteMany({ where: { sessionId: unapprovedRun.session.id } });
      await prisma.captureSession.delete({ where: { id: unapprovedRun.session.id } });

      const feed = await captureService.getLiveFeed({
        userId: user.id, sessionId: liveRun.session.id,
      });
      assert.strictEqual(feed.cards.length, 2, 'feed returns both captures');

      // The whole reason live mode is a separate path: it never likes.
      assert.strictEqual(
        await prisma.like.count({ where: { playlistId: playlist.id } }), 1,
        'CRITICAL: live capture must not like anything'
      );
    } finally {
      await prisma.captureEvent.deleteMany({ where: { sessionId: liveRun.session.id } });
      await prisma.captureSession.delete({ where: { id: liveRun.session.id } }).catch(() => {});
      await prisma.songMapping.delete({ where: { id: mapping.id } }).catch(() => {});
    }

    console.log('capture-service tests passed');
  } finally {
    await prisma.playlist.delete({ where: { id: playlist.id } }).catch(() => {});
    await prisma.$disconnect();
  }
})();
