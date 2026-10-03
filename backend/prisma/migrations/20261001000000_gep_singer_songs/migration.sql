-- 歌P singer -> song titles, recorded from play and edited on the review page.
CREATE TABLE "gep_singer_songs" (
    "id"         UUID        NOT NULL,
    "singer"     TEXT        NOT NULL,
    "title"      TEXT        NOT NULL,
    "source"     TEXT        NOT NULL DEFAULT 'game',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gep_singer_songs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gep_singer_songs_singer_title_key"
    ON "gep_singer_songs"("singer", "title");
CREATE INDEX "gep_singer_songs_title_idx"
    ON "gep_singer_songs"("title");

-- How a game title is written on the site / the platform playlist.
CREATE TABLE "gep_song_aliases" (
    "id"             UUID        NOT NULL,
    "singer_song_id" UUID        NOT NULL,
    "site_title"     TEXT        NOT NULL,
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gep_song_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gep_song_aliases_singer_song_id_site_title_key"
    ON "gep_song_aliases"("singer_song_id", "site_title");

ALTER TABLE "gep_song_aliases"
    ADD CONSTRAINT "gep_song_aliases_singer_song_id_fkey"
    FOREIGN KEY ("singer_song_id") REFERENCES "gep_singer_songs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
