-- 平台打标 (QQ / NetEase playlist auto-tagging).
-- Where a capture connection delivers when aimed at a platform playlist.
ALTER TABLE "capture_sessions" ADD COLUMN "platform_ref" TEXT;

-- One captured title per run, matched against the chosen platform playlist.
CREATE TABLE "platform_tag_events" (
    "id"                UUID        NOT NULL,
    "session_id"        UUID        NOT NULL,
    "user_id"           UUID        NOT NULL,
    "platform"          TEXT        NOT NULL,
    "playlist_ref"      TEXT        NOT NULL,
    "raw_text"          TEXT        NOT NULL,
    "outcome"           TEXT        NOT NULL,
    "candidates"        JSONB,
    "liked_external_id" TEXT,
    "error"             TEXT,
    "created_at"        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ NOT NULL,
    CONSTRAINT "platform_tag_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_tag_events_session_id_playlist_ref_raw_text_key"
    ON "platform_tag_events"("session_id", "playlist_ref", "raw_text");
CREATE INDEX "platform_tag_events_session_id_created_at_idx"
    ON "platform_tag_events"("session_id", "created_at");
CREATE INDEX "platform_tag_events_user_id_created_at_idx"
    ON "platform_tag_events"("user_id", "created_at");

ALTER TABLE "platform_tag_events"
    ADD CONSTRAINT "platform_tag_events_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "capture_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
