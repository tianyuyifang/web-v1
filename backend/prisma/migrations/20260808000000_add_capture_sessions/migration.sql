-- CreateTable
CREATE TABLE "capture_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "playlist_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "last_seen_at" TIMESTAMPTZ,

    CONSTRAINT "capture_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capture_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "raw_text" TEXT NOT NULL,
    "matched_clip_id" UUID,
    "candidates" JSONB,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "capture_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "capture_sessions_token_hash_key" ON "capture_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "capture_sessions_user_id_idx" ON "capture_sessions"("user_id");

-- CreateIndex
CREATE INDEX "capture_sessions_playlist_id_idx" ON "capture_sessions"("playlist_id");

-- CreateIndex: dedupe key — the same song is read ~15 times while on screen
CREATE UNIQUE INDEX "capture_events_session_id_raw_text_key" ON "capture_events"("session_id", "raw_text");

-- CreateIndex
CREATE INDEX "capture_events_session_id_created_at_idx" ON "capture_events"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_events" ADD CONSTRAINT "capture_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "capture_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_events" ADD CONSTRAINT "capture_events_matched_clip_id_fkey" FOREIGN KEY ("matched_clip_id") REFERENCES "clips"("id") ON DELETE SET NULL ON UPDATE CASCADE;
