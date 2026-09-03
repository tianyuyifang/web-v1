-- Verified answers for lyric passages: which real lines a game passage covers.
--
-- The matcher places 91% of lines on its own. What it misses is not a tuning
-- problem -- the game and the platform break lines differently, so the game's
-- 「那个傻瓜说的傻话」 is the platform's 「那个傻瓜」 plus 「说的傻话」 -- and
-- reading that takes understanding the words. Those answers are worked out once
-- and kept here.
--
-- Only checked answers are stored. An algorithm result is never written back:
-- freezing an unverified guess is worse than storing nothing. Absent, pending
-- and unmatchable rows all fall through to the matcher, so the page can only be
-- as good as it is today, never worse.
--
-- A new table with no foreign keys: nothing existing is altered, so this can be
-- applied while the site is serving.
CREATE TABLE "lyric_passage_matches" (
    "id" UUID NOT NULL,
    "source" "SongSource" NOT NULL,
    "external_id" TEXT NOT NULL,
    "lyric_hash" TEXT NOT NULL,
    "game_lyric" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verified_by" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "lyric_passage_matches_pkey" PRIMARY KEY ("id")
);

-- The lookup the page makes, and the uniqueness rule: one answer per passage.
CREATE UNIQUE INDEX "lyric_passage_matches_source_external_id_lyric_hash_key"
    ON "lyric_passage_matches"("source", "external_id", "lyric_hash");

-- Review queue filter.
CREATE INDEX "lyric_passage_matches_status_idx" ON "lyric_passage_matches"("status");
