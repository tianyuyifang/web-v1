-- CONCURRENTLY so captures keep writing while this builds on a 360k-row table.
-- It cannot run inside a transaction, so this file must stay a single statement.
CREATE INDEX CONCURRENTLY "capture_events_matched_clip_id_idx" ON "capture_events"("matched_clip_id");
