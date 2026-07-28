-- Distinguish automatic chapter projections from manual timeline rows.
ALTER TABLE "ChapterTimeAnchor"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "TimelineHook"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';

-- Before this discriminator existed, both tables were written only by the
-- chapter extraction runtime. Preserve that ownership during migration while
-- keeping the default for future explicitly manual rows.
UPDATE "ChapterTimeAnchor" SET "source" = 'chapter_extraction';
UPDATE "TimelineHook" SET "source" = 'chapter_extraction';

CREATE INDEX IF NOT EXISTS "TimelineHook_novelId_createdInChapterId_source_idx"
  ON "TimelineHook"("novelId", "createdInChapterId", "source");
