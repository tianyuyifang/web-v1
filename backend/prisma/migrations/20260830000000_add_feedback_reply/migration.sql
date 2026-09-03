-- An admin's reply to a piece of feedback. Its presence doubles as the status:
-- replied means handled, NULL means not yet.
ALTER TABLE "feedback" ADD COLUMN "reply" TEXT;
ALTER TABLE "feedback" ADD COLUMN "replied_at" TIMESTAMPTZ;
