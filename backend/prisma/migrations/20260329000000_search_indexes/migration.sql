-- Add indexes for pinyin search performance
CREATE INDEX IF NOT EXISTS "songs_title_pinyin_initials_idx" ON "songs"("title_pinyin_initials");
CREATE INDEX IF NOT EXISTS "songs_title_pinyin_concat_idx" ON "songs"("title_pinyin_concat");
