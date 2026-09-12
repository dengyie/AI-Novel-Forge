-- CreateTable
CREATE TABLE "M4bEncodingJob" (
    "id" TEXT NOT NULL,
    "audiobookTaskId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "workerId" TEXT,
    "workerStartedAt" TIMESTAMP(3),
    "inputWavPath" TEXT NOT NULL,
    "outputM4bPath" TEXT NOT NULL,
    "coverImagePath" TEXT,
    "metadataJson" TEXT NOT NULL,
    "progressPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M4bEncodingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL,
    "processType" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);

-- CreateIndex
CREATE UNIQUE INDEX "M4bEncodingJob_audiobookTaskId_key" ON "M4bEncodingJob"("audiobookTaskId");

-- CreateIndex
CREATE INDEX "M4bEncodingJob_status_createdAt_idx" ON "M4bEncodingJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "M4bEncodingJob" ADD CONSTRAINT "M4bEncodingJob_audiobookTaskId_fkey" FOREIGN KEY ("audiobookTaskId") REFERENCES "AudiobookTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
