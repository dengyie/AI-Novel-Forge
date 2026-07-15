-- AlterTable
ALTER TABLE "Character" ADD COLUMN "ttsPreviewAudioPath" TEXT;
ALTER TABLE "Character" ADD COLUMN "ttsPreviewSampleText" TEXT;
ALTER TABLE "Character" ADD COLUMN "ttsPreviewFingerprint" TEXT;
ALTER TABLE "Character" ADD COLUMN "ttsPreviewGeneratedAt" DATETIME;
