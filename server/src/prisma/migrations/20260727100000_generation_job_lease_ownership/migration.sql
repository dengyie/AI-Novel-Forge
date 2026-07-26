-- AlterTable
ALTER TABLE "GenerationJob"
ADD COLUMN "leaseOwner" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
