-- Distinguish automatic chapter projections from manual timeline rows.
ALTER TABLE "ChapterTimeAnchor" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "TimelineHook" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';

-- Existing rows predate manual timeline ownership and were all created by the
-- chapter extraction runtime. New rows continue to default to manual.
UPDATE "ChapterTimeAnchor" SET "source" = 'chapter_extraction';
UPDATE "TimelineHook" SET "source" = 'chapter_extraction';

ALTER TABLE "ChapterArtifactSyncCheckpoint" ADD COLUMN "contentRevision" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "ChapterArtifactSyncCheckpoint_novelId_chapterId_contentHash_artifactType_syncMode_key";
CREATE UNIQUE INDEX "ChapterArtifactSyncCheckpoint_novelId_chapterId_contentHash_artifactType_syncMode_key"
  ON "ChapterArtifactSyncCheckpoint"("novelId", "chapterId", "contentHash", "artifactType", "syncMode", "contentRevision");

CREATE INDEX "TimelineHook_novelId_createdInChapterId_source_idx"
  ON "TimelineHook"("novelId", "createdInChapterId", "source");
