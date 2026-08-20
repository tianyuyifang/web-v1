-- Keep the words the game shows while a song is being sung.
--
-- The client has been reading them all along and throwing them away, because
-- ingest accepted a title and nothing else. They are what makes a 唱卡 card
-- useful mid-game: the singer needs the passage they are about to perform, not
-- just the song it came from.
--
-- `stage` records which screen a capture came from -- 'picking' for the list of
-- songs on offer, 'singing' for the one being performed. Two things need it.
-- Dedupe: the same song appears on both screens with the same text, so keying
-- on text alone threw the performance away as a repeat, and the lyrics with it.
-- And grouping: a round is a picking screen plus the performances that follow,
-- which cannot be recovered from timestamps -- gaps within a round and between
-- rounds are both 25-35s.
ALTER TABLE "capture_events" ADD COLUMN "lyric" TEXT;
ALTER TABLE "capture_events" ADD COLUMN "stage" TEXT;

-- Existing rows predate the distinction. Left null rather than guessed at:
-- 'picking' would be wrong for any performance already recorded, and nothing
-- reads stage for history.
