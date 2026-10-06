-- QQ打标: when the current run began, so a new run matches its titles afresh
-- (platformTagService.ingest). Nullable; nothing else reads or writes it.
ALTER TABLE "capture_sessions" ADD COLUMN "platform_run_started_at" TIMESTAMPTZ;
