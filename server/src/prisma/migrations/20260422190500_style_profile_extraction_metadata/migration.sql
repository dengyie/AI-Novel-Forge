ALTER TABLE "StyleProfile" ADD COLUMN IF NOT EXISTS "extractionPresetsJson" TEXT;
ALTER TABLE "StyleProfile" ADD COLUMN IF NOT EXISTS "extractionAntiAiRuleKeysJson" TEXT;
ALTER TABLE "StyleProfile" ADD COLUMN IF NOT EXISTS "selectedExtractionPresetKey" TEXT;
