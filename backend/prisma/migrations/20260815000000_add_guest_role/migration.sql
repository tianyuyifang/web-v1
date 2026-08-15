-- GUEST: signs up and is in straight away, but cannot publish or hand out its
-- own playlists. PENDING keeps its meaning (cannot log in) and becomes where
-- expired guests and lapsed members land.
ALTER TYPE "Role" ADD VALUE 'GUEST' AFTER 'PENDING';

-- What the user was before being put in PENDING. An expired guest and a lapsed
-- member both sit in PENDING but need different wording, and the role alone
-- cannot tell them apart. Existing rows get NULL: nothing recorded it before.
ALTER TABLE "users" ADD COLUMN "previous_role" "Role";
