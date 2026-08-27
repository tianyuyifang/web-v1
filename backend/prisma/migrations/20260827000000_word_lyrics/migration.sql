-- Word-level lyrics: a time on every syllable, so the highlight can follow the
-- singing rather than slide evenly across the line.
--
-- Two nullable columns on an existing table. On PostgreSQL 11 and later that is
-- a catalogue change only -- no rewrite, no long lock -- so it is safe to apply
-- while the site is serving.
--
-- Separate from `lyric` rather than replacing it. Line-level lyrics exist for
-- effectively every song and word-level do not (measured: 100% of QQ, 35% of
-- NetEase), so the fallback has to remain.
--
-- Its own fetched-at clock, because the catalogue was fetched line-by-line long
-- before this existed. Sharing the old timestamp would mark every one of those
-- rows as already asked, and the backfill would skip the entire catalogue.
ALTER TABLE "imported_tracks" ADD COLUMN "word_lyric" TEXT;
ALTER TABLE "imported_tracks" ADD COLUMN "word_lyric_fetched_at" TIMESTAMPTZ;
