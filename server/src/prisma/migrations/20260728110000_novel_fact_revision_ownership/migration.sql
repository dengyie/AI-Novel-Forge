-- Additive ownership metadata for revision-scoped automatic facts.
ALTER TABLE "NovelFactEntry" ADD COLUMN "chapterId" TEXT;
ALTER TABLE "NovelFactEntry" ADD COLUMN "contentRevision" INTEGER;
ALTER TABLE "NovelFactEntry" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "NovelFactEntry_idempotencyKey_key"
ON "NovelFactEntry"("idempotencyKey");

CREATE INDEX "NovelFactEntry_novelId_chapterId_contentRevision_idx"
ON "NovelFactEntry"("novelId", "chapterId", "contentRevision");
