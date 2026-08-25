-- Artists whose own name contains a dash, added by hand.
--
-- The "歌名-歌手" split is made at a dash, so a dash inside the artist's name
-- is the one thing that breaks it: "幸福了然后呢-A-Lin" came apart as
-- "幸福了然后呢-A" / "Lin", and every A-Lin song failed to map.
--
-- Nearly every such name is already in imported_tracks and is found there.
-- This table is for the ones that are not -- where the game credits a group
-- and the platform credits the member, so the name never appears in the
-- catalogue at all. Until now those lived in a constant in the source, which
-- meant a deploy to add one.
--
-- One member per row, never a collaboration: a single member carrying the dash
-- settles where the dash belongs, so "IN-K" covers every pairing it will ever
-- appear in, in any order.
CREATE TABLE "dashed_artists" (
    "id"         UUID         NOT NULL,
    "name"       TEXT         NOT NULL,
    "note"       TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashed_artists_pkey" PRIMARY KEY ("id")
);

-- Lowercase on the way in, so the unique constraint is the real one rather
-- than a case-sensitive near-miss.
CREATE UNIQUE INDEX "dashed_artists_name_key" ON "dashed_artists"("name");

-- The one name that was hard-coded. 蠢货 is credited to 喻言 on QQ and to
-- THE9-喻言 in the game, so "蠢货-THE9-喻言" split into "蠢货-THE9" / "喻言".
INSERT INTO "dashed_artists" ("id", "name", "note")
VALUES (gen_random_uuid(), 'the9-喻言', '游戏署名组合，QQ 署名个人');
