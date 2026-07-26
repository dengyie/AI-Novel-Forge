-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "GenerationJob" ADD COLUMN "leaseExpiresAt" DATETIME;
