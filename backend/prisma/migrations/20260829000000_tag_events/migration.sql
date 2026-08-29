-- An append-only log of tagging a song, kept whatever happens to the like.
--
-- `likes` answers "is this clip marked right now" -- that is what a playlist
-- renders from, so unliking deletes the row and clearing a playlist deletes
-- every row in it. It therefore cannot answer "how much is this person using
-- the site". Measured before this table existed: one singer had tagged 3,704
-- songs in ten days and had 188 likes left, because tagging a set and clearing
-- it afterwards is the normal way to play. The admin view read 188 and showed
-- their last activity as five days ago while they were tagging that same
-- afternoon -- the people using it most were the ones whose history vanished
-- fastest.
--
-- So this records the act, not the state. Tagging the same song again the next
-- night writes another row on purpose: it happened twice. Untagging writes
-- nothing and removes nothing.
--
-- A new empty table, so this migration takes no lock worth worrying about and
-- is safe to apply while the site is serving.

CREATE TABLE "tag_events" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     UUID         NOT NULL,
  "playlist_id" UUID         NOT NULL,
  "clip_id"     UUID         NOT NULL,
  -- Whether 自动打标 wrote this or the singer pressed it. Both are tagging;
  -- the split says which way that person works.
  "auto"        BOOLEAN      NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tag_events_pkey" PRIMARY KEY ("id")
);

-- The admin view asks "who tagged, and when", per user, newest first.
CREATE INDEX "tag_events_user_id_created_at_idx" ON "tag_events" ("user_id", "created_at");
-- The nightly prune deletes by age across every user.
CREATE INDEX "tag_events_created_at_idx" ON "tag_events" ("created_at");

-- Only the user cascades. A deleted account should take its history with it,
-- but deleting a song or a playlist must not erase the fact that someone once
-- tagged it -- the ids stay as plain columns so a later question ("which songs
-- get tagged most") remains answerable even after the clip is gone.
ALTER TABLE "tag_events"
  ADD CONSTRAINT "tag_events_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
