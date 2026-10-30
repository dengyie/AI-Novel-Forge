-- LLM 输入缓存用量列（命中/未命中/写入 + 上报计数）。命中包含于输入总量，不参与预算口径；
-- 只有厂商明确上报的调用才累计这些列，缺报告保持 NULL（未知 ≠ 0）。
ALTER TABLE "GenerationJob" ADD COLUMN "cacheHitTokens" INTEGER;
ALTER TABLE "GenerationJob" ADD COLUMN "cacheMissTokens" INTEGER;
ALTER TABLE "GenerationJob" ADD COLUMN "cacheWriteTokens" INTEGER;
ALTER TABLE "GenerationJob" ADD COLUMN "cacheReportedCount" INTEGER;

ALTER TABLE "NovelWorkflowTask" ADD COLUMN "cacheHitTokens" INTEGER;
ALTER TABLE "NovelWorkflowTask" ADD COLUMN "cacheMissTokens" INTEGER;
ALTER TABLE "NovelWorkflowTask" ADD COLUMN "cacheWriteTokens" INTEGER;
ALTER TABLE "NovelWorkflowTask" ADD COLUMN "cacheReportedCount" INTEGER;

ALTER TABLE "StyleExtractionTask" ADD COLUMN "cacheHitTokens" INTEGER;
ALTER TABLE "StyleExtractionTask" ADD COLUMN "cacheMissTokens" INTEGER;
ALTER TABLE "StyleExtractionTask" ADD COLUMN "cacheWriteTokens" INTEGER;
ALTER TABLE "StyleExtractionTask" ADD COLUMN "cacheReportedCount" INTEGER;

ALTER TABLE "AudiobookTask" ADD COLUMN "cacheHitTokens" INTEGER;
ALTER TABLE "AudiobookTask" ADD COLUMN "cacheMissTokens" INTEGER;
ALTER TABLE "AudiobookTask" ADD COLUMN "cacheWriteTokens" INTEGER;
ALTER TABLE "AudiobookTask" ADD COLUMN "cacheReportedCount" INTEGER;

ALTER TABLE "DirectorLlmUsageRecord" ADD COLUMN "cacheHitTokens" INTEGER;
ALTER TABLE "DirectorLlmUsageRecord" ADD COLUMN "cacheMissTokens" INTEGER;
ALTER TABLE "DirectorLlmUsageRecord" ADD COLUMN "cacheWriteTokens" INTEGER;
