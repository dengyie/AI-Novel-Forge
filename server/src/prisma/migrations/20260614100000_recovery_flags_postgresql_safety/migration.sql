ALTER TABLE "BookAnalysis"
ADD COLUMN IF NOT EXISTS "pendingManualRecovery" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "GenerationJob"
ADD COLUMN IF NOT EXISTS "pendingManualRecovery" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ImageGenerationTask"
ADD COLUMN IF NOT EXISTS "pendingManualRecovery" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "NovelWorkflowTask"
ADD COLUMN IF NOT EXISTS "pendingManualRecovery" BOOLEAN NOT NULL DEFAULT false;
