-- Keep the platform's lyrics next to the track they belong to.
--
-- Lyrics were fetched on every request and never kept. That matters more than
-- it sounds: unlike playback resolution, the lyric call carries no credential
-- at all, so it leaves as the server over the one IP every user shares -- and
-- these platforms rate-limit by address, not by account. Measured at 7.2
-- requests a second sustained with nothing in the way. The fix is to stop
-- asking rather than to ask more slowly.
--
-- A cache in memory would not do. A restart empties it, and every card opened
-- afterwards goes back to the platform at once -- exactly the burst this is
-- meant to prevent, arriving precisely when the process is least ready for it.
--
-- Cheap to keep: a lyric measured about 2KB, so the whole catalogue is ~6MB
-- before TOAST compresses it, and roughly a third of that after.
ALTER TABLE "imported_tracks" ADD COLUMN "lyric" TEXT;

-- Records the attempt, not just the answer.
--
-- Plenty of tracks have no lyrics -- instrumentals, and anything the platform
-- simply lacks. Without this column those are indistinguishable from tracks
-- never asked about, so each one would be re-fetched forever and the songs
-- that benefit least from caching would generate all of the traffic.
--
-- Null on every existing row, which is correct: none of them has been asked.
ALTER TABLE "imported_tracks" ADD COLUMN "lyric_fetched_at" TIMESTAMPTZ;
