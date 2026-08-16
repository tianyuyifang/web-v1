-- Live singing cards: map what the game shows to something playable.
--
-- Two tables, deliberately separate:
--   song_mappings   game title+artist -> exactly one playable id
--   imported_tracks tracks pulled from a trusted platform playlist, waiting
--                   to be claimed by a game song
-- They are different populations. An imported track has no game-side key yet
-- and many will never appear in a game at all; merging them would leave
-- half-populated mapping rows that no lookup could use.

-- Where a song's audio comes from. LOCAL is not a default-wins shortcut — it
-- is one source among three, picked per song at approval time. Local costs
-- our bandwidth (3-5 MB a play) while the platforms cost none, so external is
-- preferred and local is reserved for what the platforms cannot serve.
CREATE TYPE "SongSource" AS ENUM ('LOCAL', 'QQ', 'NETEASE');

-- Lets a couple of trusted people approve mappings without making them
-- admins. A flag rather than a role because it cuts across the existing
-- ladder. One wrong approval is site-wide, so it stays narrow by default;
-- every ADMIN is treated as holding it implicitly, in code rather than here.
ALTER TABLE "users" ADD COLUMN "can_edit_mapping" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "song_mappings" (
    "id"              UUID         NOT NULL,

    -- Normalised game-side key: lowercased, width-folded, and for artists
    -- split/sorted/rejoined so 汪苏泷/赵露思 and 赵露思/汪苏泷 are one key.
    -- Raw forms kept for display and for re-normalising if the rules change.
    "title_key"       TEXT         NOT NULL,
    "artist_key"      TEXT         NOT NULL,
    "raw_title"       TEXT         NOT NULL,
    "raw_artist"      TEXT         NOT NULL,

    "source"          "SongSource" NOT NULL,
    -- Song UUID when source is LOCAL, else the platform's own id (QQ songmid,
    -- NetEase numeric id). A plain string on purpose: the three id spaces have
    -- nothing in common and a foreign key would only fit one of them.
    "external_id"     TEXT         NOT NULL,

    -- What the platform calls it. The game says 奢香夫人/凤凰传奇 where QQ says
    -- 奢香夫人/玲花_曾毅 — once the mapping exists this disagreement is
    -- irrelevant to playback, so these are display-only, for human review.
    "platform_title"  TEXT,
    "platform_artist" TEXT,
    -- Cheapest way to tell same-titled versions apart (studio/live/cover).
    "duration_sec"    INTEGER,

    -- Approved rows are frozen: automatic search neither overwrites nor
    -- re-searches them. That freeze is the point — it is what stops lookups
    -- hitting the platforms, which is what keeps us out of rate limiting.
    "approved"        BOOLEAN      NOT NULL DEFAULT false,
    -- import | search. Shown as a tag during review; once approved it stops
    -- mattering, so it is not a separate review bucket.
    "origin"          TEXT         NOT NULL DEFAULT 'search',
    -- exact | title-only | fuzzy. Why the importer believed this match.
    -- Drives review ordering: exact self-approves, the rest queue for a human.
    "match_kind"      TEXT,
    -- Rejected alternatives, so review can offer them without searching again.
    "candidates"      JSONB,
    "note"            TEXT,

    "approved_by_id"  UUID,
    "approved_at"     TIMESTAMPTZ,
    "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "song_mappings_pkey" PRIMARY KEY ("id")
);

-- One mapping per game song. The artist is part of the key, never an
-- attribute: 致青春/王菲 and 致青春/李宇春 are different songs that must not
-- collide. Nothing may look a mapping up by title alone.
CREATE UNIQUE INDEX "song_mappings_title_key_artist_key_key"
    ON "song_mappings" ("title_key", "artist_key");
-- Review queue: unapproved first, newest first.
CREATE INDEX "song_mappings_approved_created_at_idx"
    ON "song_mappings" ("approved", "created_at");
-- Lets the importer find every row it could fill from one platform.
CREATE INDEX "song_mappings_source_idx" ON "song_mappings" ("source");

-- Approver is a soft link: losing the account must not delete the mapping,
-- which is shared site-wide and expensive to rebuild.
ALTER TABLE "song_mappings"
    ADD CONSTRAINT "song_mappings_approved_by_id_fkey"
    FOREIGN KEY ("approved_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "imported_tracks" (
    "id"           UUID         NOT NULL,
    "source"       "SongSource" NOT NULL,
    "external_id"  TEXT         NOT NULL,

    "title"        TEXT         NOT NULL,
    "artist"       TEXT         NOT NULL,
    -- Same normalisation as song_mappings, so matching is an indexed lookup
    -- rather than a scan over every imported row.
    "title_key"    TEXT         NOT NULL,
    "artist_key"   TEXT         NOT NULL,
    "duration_sec" INTEGER,
    "album"        TEXT,
    -- Platform marks this VIP-only (QQ pay_play=1, NetEase fee=1). Lets review
    -- predict "this will not play" before anyone tries it.
    "vip_only"     BOOLEAN      NOT NULL DEFAULT false,

    -- Which playlist it came from, for tracing a bad batch back to its source.
    "playlist_ref" TEXT,
    -- Set once a game song claims this track. This is the "seen in play" flag
    -- that makes the review page's coverage counter meaningful.
    "matched_at"   TIMESTAMPTZ,
    "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imported_tracks_pkey" PRIMARY KEY ("id")
);

-- Re-importing the same playlist updates rows instead of duplicating them.
CREATE UNIQUE INDEX "imported_tracks_source_external_id_key"
    ON "imported_tracks" ("source", "external_id");
-- The importer's hot path: given a game song, find candidates. The title-only
-- index backs the fallback for when the game and the platform disagree on the
-- artist, which they regularly do.
CREATE INDEX "imported_tracks_title_key_artist_key_idx"
    ON "imported_tracks" ("title_key", "artist_key");
CREATE INDEX "imported_tracks_title_key_idx"
    ON "imported_tracks" ("title_key");
