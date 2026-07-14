-- AlterTable
ALTER TABLE "Novel" ADD COLUMN "audiobookNarratorVoice" TEXT;
ALTER TABLE "Novel" ADD COLUMN "audiobookNarratorStyle" TEXT;

-- AlterTable
ALTER TABLE "Character" ADD COLUMN "ttsVoice" TEXT;
ALTER TABLE "Character" ADD COLUMN "ttsStyle" TEXT;

-- CreateTable
CREATE TABLE "AudiobookTask" (
    "id" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scopeMode" TEXT NOT NULL,
    "chapterIdsJson" TEXT NOT NULL DEFAULT '[]',
    "chapterCount" INTEGER NOT NULL DEFAULT 0,
    "completedChapterCount" INTEGER NOT NULL DEFAULT 0,
    "narratorVoice" TEXT NOT NULL,
    "narratorStyle" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "temperature" DOUBLE PRECISION,
    "status" "PipelineJobStatus" NOT NULL DEFAULT 'queued',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 1,
    "pendingManualRecovery" BOOLEAN NOT NULL DEFAULT false,
    "heartbeatAt" TIMESTAMP(3),
    "currentStage" TEXT,
    "currentItemKey" TEXT,
    "currentItemLabel" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "error" TEXT,
    "summary" TEXT,
    "annotationsJson" TEXT,
    "progressJson" TEXT,
    "resultJson" TEXT,
    "outputDir" TEXT,
    "fullAudioPath" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "llmCallCount" INTEGER NOT NULL DEFAULT 0,
    "lastTokenRecordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudiobookTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudiobookTask_novelId_updatedAt_idx" ON "AudiobookTask"("novelId", "updatedAt");

-- CreateIndex
CREATE INDEX "AudiobookTask_status_updatedAt_idx" ON "AudiobookTask"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "AudiobookTask" ADD CONSTRAINT "AudiobookTask_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
