ALTER TABLE "M4bEncodingJob" ADD COLUMN "generationToken" TEXT;
ALTER TABLE "M4bEncodingJob" ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "M4bEncodingJob" ADD COLUMN "lastProgressAt" DATETIME;
-- Unowned legacy jobs cannot safely publish into a newer task generation.
UPDATE "M4bEncodingJob" SET "status" = 'failed', "errorMessage" = 'Encoding ownership unavailable; retry audiobook packaging.' WHERE "status" IN ('pending', 'processing');
