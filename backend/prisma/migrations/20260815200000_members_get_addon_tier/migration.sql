-- Everyone who is a member today counts as 加订版: they have been using
-- auto-tagging while it was an included feature, and the tier is what they
-- would have to buy to keep it. Idempotent — the previous migration already
-- set most of these, this catches any member added since.
UPDATE "users"
SET "entitlements" = ARRAY['capture']
WHERE "role" = 'MEMBER'
  AND NOT ('capture' = ANY("entitlements"));

-- Guests no longer get add-ons for free, so clear anything they hold. None
-- were ever granted explicitly — the old rule handed the features out in
-- code — but this makes the data say what the rules now say.
UPDATE "users"
SET "entitlements" = '{}'
WHERE "role" = 'GUEST'
  AND array_length("entitlements", 1) IS NOT NULL;
