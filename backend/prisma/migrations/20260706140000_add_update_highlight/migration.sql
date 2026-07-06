-- Highlight flag for update posts. At most one update can be highlighted at a time,
-- enforced by a partial unique index (only constrains rows where is_highlighted = true;
-- any number of false rows is allowed, so "nothing highlighted" is always valid).
ALTER TABLE "updates" ADD COLUMN "is_highlighted" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "idx_updates_single_highlight" ON "updates" ("is_highlighted") WHERE "is_highlighted" = true;
