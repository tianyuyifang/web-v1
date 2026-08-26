-- Per-singer, per-recording preferences: key, tempo, a note, colour flags.
--
-- A new table, so nothing existing is touched: no column is added to a hot
-- table, no index is rebuilt, and nothing takes a lock that ingest could queue
-- behind. Rolling back is a DROP.
--
-- Not a key inside users.preferences, which was the tempting option since that
-- jsonb column already exists. PostgreSQL rewrites an entire jsonb value on
-- every update, measured here at 24x the WAL per change (6,268 bytes against
-- 257) and crossing the 2 kB TOAST threshold at roughly twenty saved songs --
-- and that column also holds the encrypted platform cookies, so a frequently
-- written map would share a row with credentials. Rows are cheap instead: 146
-- bytes measured all-in, 2.3 MB for every capture user keeping 300 songs.
--
-- pitch and speed are nullable AND meaningful at their defaults. A singer who
-- tries +2, decides against it and settles back on the original has decided
-- something; storing 0 is not the same as storing nothing.
CREATE TABLE "song_prefs" (
    "user_id"     UUID NOT NULL,
    "source"      "SongSource" NOT NULL,
    "external_id" TEXT NOT NULL,
    "pitch"       INTEGER,
    "speed"       DOUBLE PRECISION,
    "note"        TEXT,
    "color_tag"   TEXT,
    "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "song_prefs_pkey" PRIMARY KEY ("user_id", "source", "external_id")
);

-- The only read is "this user, these recordings on screen", which the primary
-- key answers directly -- measured as an index scan at 0.44 ms against a
-- deliberately oversized million-row table. No second index is warranted.

-- Deleting an account takes its preferences with it. They are worth nothing
-- without the singer, and leaving them would be an orphaned row holding a note
-- someone wrote.
ALTER TABLE "song_prefs" ADD CONSTRAINT "song_prefs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
