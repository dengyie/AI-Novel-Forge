-- AlterTable
ALTER TABLE "AutoDirectorFollowUpNotificationLog" ADD COLUMN "readAt" DATETIME;

-- AlterTable
ALTER TABLE "ComicPanel" ADD COLUMN "sceneRef" TEXT;

-- CreateTable
CREATE TABLE "PromptSlotOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "novelId" TEXT,
    "promptId" TEXT NOT NULL,
    "baseVersion" TEXT NOT NULL,
    "slots" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PromptSlotOverride_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "M4bEncodingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "audiobookTaskId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "workerId" TEXT,
    "workerStartedAt" DATETIME,
    "inputWavPath" TEXT NOT NULL,
    "outputM4bPath" TEXT NOT NULL,
    "coverImagePath" TEXT,
    "metadataJson" TEXT NOT NULL,
    "progressPercent" REAL NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "M4bEncodingJob_audiobookTaskId_fkey" FOREIGN KEY ("audiobookTaskId") REFERENCES "AudiobookTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL PRIMARY KEY,
    "processType" TEXT NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ComicCharacterAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageData" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComicCharacterAsset_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "ComicCharacter" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComicCharacterAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ComicScene" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sceneType" TEXT NOT NULL DEFAULT 'interior',
    "bible" TEXT,
    "sheetData" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComicScene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT,
    "chapterId" TEXT,
    "sessionId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "entryAgent" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "currentStep" TEXT,
    "currentAgent" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRun_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentRun" ("chapterId", "createdAt", "currentAgent", "currentStep", "entryAgent", "error", "finishedAt", "goal", "id", "metadataJson", "novelId", "sessionId", "startedAt", "status", "updatedAt") SELECT "chapterId", "createdAt", "currentAgent", "currentStep", "entryAgent", "error", "finishedAt", "goal", "id", "metadataJson", "novelId", "sessionId", "startedAt", "status", "updatedAt" FROM "AgentRun";
DROP TABLE "AgentRun";
ALTER TABLE "new_AgentRun" RENAME TO "AgentRun";
CREATE INDEX "AgentRun_status_updatedAt_idx" ON "AgentRun"("status", "updatedAt");
CREATE INDEX "AgentRun_novelId_createdAt_idx" ON "AgentRun"("novelId", "createdAt");
CREATE INDEX "AgentRun_novelId_chapterId_createdAt_idx" ON "AgentRun"("novelId", "chapterId", "createdAt");
CREATE INDEX "AgentRun_sessionId_createdAt_idx" ON "AgentRun"("sessionId", "createdAt");
CREATE TABLE "new_BookAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "summary" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "temperature" REAL,
    "maxTokens" INTEGER,
    "budgetTokens" INTEGER,
    "usedTokens" INTEGER DEFAULT 0,
    "userFocusInstruction" TEXT,
    "sourceStartChapterIndex" INTEGER,
    "sourceEndChapterIndex" INTEGER,
    "sourceStartOffset" INTEGER,
    "sourceEndOffset" INTEGER,
    "sourceScopeLabel" TEXT,
    "progress" REAL NOT NULL DEFAULT 0,
    "pendingManualRecovery" BOOLEAN NOT NULL DEFAULT false,
    "heartbeatAt" DATETIME,
    "currentStage" TEXT,
    "currentItemKey" TEXT,
    "currentItemLabel" TEXT,
    "cancelRequestedAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "lastRunAt" DATETIME,
    "publishedDocumentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookAnalysis_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookAnalysis_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "KnowledgeDocumentVersion" ("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "BookAnalysis_publishedDocumentId_fkey" FOREIGN KEY ("publishedDocumentId") REFERENCES "KnowledgeDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BookAnalysis" ("attemptCount", "budgetTokens", "cancelRequestedAt", "createdAt", "currentItemKey", "currentItemLabel", "currentStage", "documentId", "documentVersionId", "heartbeatAt", "id", "lastError", "lastRunAt", "maxAttempts", "maxTokens", "model", "pendingManualRecovery", "progress", "provider", "publishedDocumentId", "sourceEndChapterIndex", "sourceEndOffset", "sourceScopeLabel", "sourceStartChapterIndex", "sourceStartOffset", "status", "summary", "temperature", "title", "updatedAt", "usedTokens", "userFocusInstruction") SELECT "attemptCount", "budgetTokens", "cancelRequestedAt", "createdAt", "currentItemKey", "currentItemLabel", "currentStage", "documentId", "documentVersionId", "heartbeatAt", "id", "lastError", "lastRunAt", "maxAttempts", "maxTokens", "model", "pendingManualRecovery", "progress", "provider", "publishedDocumentId", "sourceEndChapterIndex", "sourceEndOffset", "sourceScopeLabel", "sourceStartChapterIndex", "sourceStartOffset", "status", "summary", "temperature", "title", "updatedAt", "usedTokens", "userFocusInstruction" FROM "BookAnalysis";
DROP TABLE "BookAnalysis";
ALTER TABLE "new_BookAnalysis" RENAME TO "BookAnalysis";
CREATE INDEX "BookAnalysis_documentId_status_idx" ON "BookAnalysis"("documentId", "status");
CREATE INDEX "BookAnalysis_documentVersionId_idx" ON "BookAnalysis"("documentVersionId");
CREATE INDEX "BookAnalysis_status_updatedAt_idx" ON "BookAnalysis"("status", "updatedAt");
CREATE TABLE "new_BookAnalysisCharacter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "briefDescription" TEXT,
    "importance" TEXT,
    "occurringChaptersJson" TEXT,
    "lastGenerationError" TEXT,
    "generationDepth" TEXT NOT NULL DEFAULT 'standard',
    "selectedDimensionsJson" TEXT,
    "profileJson" TEXT,
    "depthMetadataJson" TEXT,
    "profileSectionsJson" TEXT,
    "evidenceJson" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookAnalysisCharacter_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "BookAnalysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BookAnalysisCharacter" ("analysisId", "briefDescription", "createdAt", "depthMetadataJson", "evidenceJson", "generationDepth", "id", "importance", "lastGenerationError", "name", "occurringChaptersJson", "profileJson", "profileSectionsJson", "role", "selectedDimensionsJson", "sortOrder", "status", "updatedAt") SELECT "analysisId", "briefDescription", "createdAt", "depthMetadataJson", "evidenceJson", "generationDepth", "id", "importance", "lastGenerationError", "name", "occurringChaptersJson", "profileJson", "profileSectionsJson", "role", "selectedDimensionsJson", "sortOrder", "status", "updatedAt" FROM "BookAnalysisCharacter";
DROP TABLE "BookAnalysisCharacter";
ALTER TABLE "new_BookAnalysisCharacter" RENAME TO "BookAnalysisCharacter";
CREATE INDEX "BookAnalysisCharacter_analysisId_sortOrder_idx" ON "BookAnalysisCharacter"("analysisId", "sortOrder");
CREATE INDEX "BookAnalysisCharacter_analysisId_name_idx" ON "BookAnalysisCharacter"("analysisId", "name");
CREATE INDEX "BookAnalysisCharacter_analysisId_status_idx" ON "BookAnalysisCharacter"("analysisId", "status");
CREATE TABLE "new_BookAnalysisCharacterAppearance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "coveragePercent" INTEGER NOT NULL DEFAULT 0,
    "consolidatedAppearanceJson" TEXT,
    "variantPolicyJson" TEXT,
    "lastIndexedChapterIndex" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookAnalysisCharacterAppearance_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "BookAnalysisCharacter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BookAnalysisCharacterAppearance" ("characterId", "consolidatedAppearanceJson", "coveragePercent", "createdAt", "id", "lastIndexedChapterIndex", "updatedAt", "variantPolicyJson") SELECT "characterId", "consolidatedAppearanceJson", "coveragePercent", "createdAt", "id", "lastIndexedChapterIndex", "updatedAt", "variantPolicyJson" FROM "BookAnalysisCharacterAppearance";
DROP TABLE "BookAnalysisCharacterAppearance";
ALTER TABLE "new_BookAnalysisCharacterAppearance" RENAME TO "BookAnalysisCharacterAppearance";
CREATE UNIQUE INDEX "BookAnalysisCharacterAppearance_characterId_key" ON "BookAnalysisCharacterAppearance"("characterId");
CREATE INDEX "BookAnalysisCharacterAppearance_coveragePercent_idx" ON "BookAnalysisCharacterAppearance"("coveragePercent");
CREATE TABLE "new_BookAnalysisCharacterAppearanceImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "generationTaskId" TEXT,
    "imageAssetId" TEXT,
    "imagePromptJson" TEXT,
    "referenceAssetIdsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookAnalysisCharacterAppearanceImage_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BookAnalysisCharacterAppearanceSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookAnalysisCharacterAppearanceImage_generationTaskId_fkey" FOREIGN KEY ("generationTaskId") REFERENCES "ImageGenerationTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BookAnalysisCharacterAppearanceImage_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "ImageAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BookAnalysisCharacterAppearanceImage" ("createdAt", "generationTaskId", "id", "imageAssetId", "imagePromptJson", "referenceAssetIdsJson", "snapshotId", "updatedAt") SELECT "createdAt", "generationTaskId", "id", "imageAssetId", "imagePromptJson", "referenceAssetIdsJson", "snapshotId", "updatedAt" FROM "BookAnalysisCharacterAppearanceImage";
DROP TABLE "BookAnalysisCharacterAppearanceImage";
ALTER TABLE "new_BookAnalysisCharacterAppearanceImage" RENAME TO "BookAnalysisCharacterAppearanceImage";
CREATE INDEX "BookAnalysisCharacterAppearanceImage_generationTaskId_idx" ON "BookAnalysisCharacterAppearanceImage"("generationTaskId");
CREATE INDEX "BookAnalysisCharacterAppearanceImage_snapshotId_idx" ON "BookAnalysisCharacterAppearanceImage"("snapshotId");
CREATE UNIQUE INDEX "BookAnalysisCharacterAppearanceImage_imageAssetId_key" ON "BookAnalysisCharacterAppearanceImage"("imageAssetId");
CREATE TABLE "new_BookAnalysisCharacterAppearanceSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appearanceId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "chapterTitle" TEXT,
    "appearanceJson" TEXT,
    "evidenceJson" TEXT,
    "summaryCaption" TEXT,
    "contextSceneRefsJson" TEXT,
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookAnalysisCharacterAppearanceSnapshot_appearanceId_fkey" FOREIGN KEY ("appearanceId") REFERENCES "BookAnalysisCharacterAppearance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookAnalysisCharacterAppearanceSnapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "BookAnalysisCharacter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BookAnalysisCharacterAppearanceSnapshot" ("appearanceId", "appearanceJson", "chapterIndex", "chapterTitle", "characterId", "contextSceneRefsJson", "createdAt", "evidenceJson", "id", "manuallyEdited", "summaryCaption", "updatedAt") SELECT "appearanceId", "appearanceJson", "chapterIndex", "chapterTitle", "characterId", "contextSceneRefsJson", "createdAt", "evidenceJson", "id", "manuallyEdited", "summaryCaption", "updatedAt" FROM "BookAnalysisCharacterAppearanceSnapshot";
DROP TABLE "BookAnalysisCharacterAppearanceSnapshot";
ALTER TABLE "new_BookAnalysisCharacterAppearanceSnapshot" RENAME TO "BookAnalysisCharacterAppearanceSnapshot";
CREATE INDEX "BookAnalysisCharacterAppearanceSnapshot_appearanceId_chapterIndex_idx" ON "BookAnalysisCharacterAppearanceSnapshot"("appearanceId", "chapterIndex");
CREATE INDEX "BookAnalysisCharacterAppearanceSnapshot_characterId_chapterIndex_idx" ON "BookAnalysisCharacterAppearanceSnapshot"("characterId", "chapterIndex");
CREATE INDEX "BookAnalysisCharacterAppearanceSnapshot_chapterIndex_idx" ON "BookAnalysisCharacterAppearanceSnapshot"("chapterIndex");
CREATE UNIQUE INDEX "BookAnalysisCharacterAppearanceSnapshot_characterId_chapterIndex_key" ON "BookAnalysisCharacterAppearanceSnapshot"("characterId", "chapterIndex");
CREATE TABLE "new_BookAnalysisCharacterAppearanceTerm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "category" TEXT,
    "confidence" REAL,
    "stability" TEXT,
    "evidenceJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookAnalysisCharacterAppearanceTerm_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "BookAnalysisCharacter" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookAnalysisCharacterAppearanceTerm_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BookAnalysisCharacterAppearanceSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BookAnalysisCharacterAppearanceTerm" ("category", "chapterIndex", "characterId", "confidence", "createdAt", "evidenceJson", "id", "snapshotId", "stability", "status", "text", "updatedAt") SELECT "category", "chapterIndex", "characterId", "confidence", "createdAt", "evidenceJson", "id", "snapshotId", "stability", "status", "text", "updatedAt" FROM "BookAnalysisCharacterAppearanceTerm";
DROP TABLE "BookAnalysisCharacterAppearanceTerm";
ALTER TABLE "new_BookAnalysisCharacterAppearanceTerm" RENAME TO "BookAnalysisCharacterAppearanceTerm";
CREATE INDEX "BookAnalysisCharacterAppearanceTerm_characterId_status_updatedAt_idx" ON "BookAnalysisCharacterAppearanceTerm"("characterId", "status", "updatedAt");
CREATE INDEX "BookAnalysisCharacterAppearanceTerm_snapshotId_idx" ON "BookAnalysisCharacterAppearanceTerm"("snapshotId");
CREATE INDEX "BookAnalysisCharacterAppearanceTerm_chapterIndex_idx" ON "BookAnalysisCharacterAppearanceTerm"("chapterIndex");
CREATE UNIQUE INDEX "BookAnalysisCharacterAppearanceTerm_snapshotId_text_key" ON "BookAnalysisCharacterAppearanceTerm"("snapshotId", "text");
CREATE TABLE "new_ComicCharacter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT NOT NULL DEFAULT 'unknown',
    "persona" TEXT,
    "visualAnchor" TEXT,
    "sheetData" TEXT,
    "sourceCharacterRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComicCharacter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ComicCharacter" ("createdAt", "id", "name", "persona", "projectId", "sheetData", "sourceCharacterRef", "updatedAt", "visualAnchor") SELECT "createdAt", "id", "name", "persona", "projectId", "sheetData", "sourceCharacterRef", "updatedAt", "visualAnchor" FROM "ComicCharacter";
DROP TABLE "ComicCharacter";
ALTER TABLE "new_ComicCharacter" RENAME TO "ComicCharacter";
CREATE INDEX "ComicCharacter_projectId_idx" ON "ComicCharacter"("projectId");
CREATE TABLE "new_DirectorRuntimeCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeId" TEXT NOT NULL,
    "workflowTaskId" TEXT,
    "novelId" TEXT,
    "legacyCommandId" TEXT,
    "commandType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "payloadJson" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DirectorRuntimeCommand_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "DirectorRuntimeInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DirectorRuntimeCommand" ("attempt", "commandType", "createdAt", "errorMessage", "finishedAt", "id", "idempotencyKey", "leaseExpiresAt", "leaseOwner", "legacyCommandId", "novelId", "payloadJson", "priority", "runAfter", "runtimeId", "startedAt", "status", "updatedAt", "workflowTaskId") SELECT "attempt", "commandType", "createdAt", "errorMessage", "finishedAt", "id", "idempotencyKey", "leaseExpiresAt", "leaseOwner", "legacyCommandId", "novelId", "payloadJson", "priority", "runAfter", "runtimeId", "startedAt", "status", "updatedAt", "workflowTaskId" FROM "DirectorRuntimeCommand";
DROP TABLE "DirectorRuntimeCommand";
ALTER TABLE "new_DirectorRuntimeCommand" RENAME TO "DirectorRuntimeCommand";
CREATE UNIQUE INDEX "DirectorRuntimeCommand_legacyCommandId_key" ON "DirectorRuntimeCommand"("legacyCommandId");
CREATE INDEX "DirectorRuntimeCommand_runtimeId_status_updatedAt_idx" ON "DirectorRuntimeCommand"("runtimeId", "status", "updatedAt");
CREATE INDEX "DirectorRuntimeCommand_status_priority_runAfter_createdAt_idx" ON "DirectorRuntimeCommand"("status", "priority", "runAfter", "createdAt");
CREATE INDEX "DirectorRuntimeCommand_workflowTaskId_status_updatedAt_idx" ON "DirectorRuntimeCommand"("workflowTaskId", "status", "updatedAt");
CREATE INDEX "DirectorRuntimeCommand_novelId_status_updatedAt_idx" ON "DirectorRuntimeCommand"("novelId", "status", "updatedAt");
CREATE INDEX "DirectorRuntimeCommand_leaseOwner_leaseExpiresAt_idx" ON "DirectorRuntimeCommand"("leaseOwner", "leaseExpiresAt");
CREATE UNIQUE INDEX "DirectorRuntimeCommand_runtimeId_commandType_idempotencyKey_key" ON "DirectorRuntimeCommand"("runtimeId", "commandType", "idempotencyKey");
CREATE TABLE "new_DirectorRuntimeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeId" TEXT NOT NULL,
    "commandId" TEXT,
    "executionId" TEXT,
    "workflowTaskId" TEXT,
    "novelId" TEXT,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "severity" TEXT,
    "metadataJson" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectorRuntimeEvent_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "DirectorRuntimeInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DirectorRuntimeEvent_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "DirectorRuntimeCommand" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DirectorRuntimeEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "DirectorRuntimeExecution" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DirectorRuntimeEvent" ("commandId", "createdAt", "executionId", "id", "metadataJson", "novelId", "occurredAt", "runtimeId", "severity", "summary", "type", "workflowTaskId") SELECT "commandId", "createdAt", "executionId", "id", "metadataJson", "novelId", "occurredAt", "runtimeId", "severity", "summary", "type", "workflowTaskId" FROM "DirectorRuntimeEvent";
DROP TABLE "DirectorRuntimeEvent";
ALTER TABLE "new_DirectorRuntimeEvent" RENAME TO "DirectorRuntimeEvent";
CREATE INDEX "DirectorRuntimeEvent_runtimeId_occurredAt_idx" ON "DirectorRuntimeEvent"("runtimeId", "occurredAt");
CREATE INDEX "DirectorRuntimeEvent_commandId_occurredAt_idx" ON "DirectorRuntimeEvent"("commandId", "occurredAt");
CREATE INDEX "DirectorRuntimeEvent_executionId_occurredAt_idx" ON "DirectorRuntimeEvent"("executionId", "occurredAt");
CREATE INDEX "DirectorRuntimeEvent_workflowTaskId_occurredAt_idx" ON "DirectorRuntimeEvent"("workflowTaskId", "occurredAt");
CREATE INDEX "DirectorRuntimeEvent_novelId_occurredAt_idx" ON "DirectorRuntimeEvent"("novelId", "occurredAt");
CREATE INDEX "DirectorRuntimeEvent_type_occurredAt_idx" ON "DirectorRuntimeEvent"("type", "occurredAt");
CREATE TABLE "new_DirectorRuntimeExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeId" TEXT NOT NULL,
    "commandId" TEXT,
    "workflowTaskId" TEXT,
    "novelId" TEXT,
    "legacyCommandId" TEXT,
    "activeLockKey" TEXT,
    "workerId" TEXT,
    "slotId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'leased',
    "stepType" TEXT NOT NULL,
    "resourceClass" TEXT,
    "leaseExpiresAt" DATETIME,
    "heartbeatAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "inputHash" TEXT,
    "checkpointVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DirectorRuntimeExecution_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "DirectorRuntimeInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DirectorRuntimeExecution_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "DirectorRuntimeCommand" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DirectorRuntimeExecution" ("activeLockKey", "checkpointVersion", "commandId", "createdAt", "errorClass", "errorMessage", "finishedAt", "heartbeatAt", "id", "inputHash", "leaseExpiresAt", "legacyCommandId", "novelId", "resourceClass", "runtimeId", "slotId", "startedAt", "status", "stepType", "updatedAt", "workerId", "workflowTaskId") SELECT "activeLockKey", "checkpointVersion", "commandId", "createdAt", "errorClass", "errorMessage", "finishedAt", "heartbeatAt", "id", "inputHash", "leaseExpiresAt", "legacyCommandId", "novelId", "resourceClass", "runtimeId", "slotId", "startedAt", "status", "stepType", "updatedAt", "workerId", "workflowTaskId" FROM "DirectorRuntimeExecution";
DROP TABLE "DirectorRuntimeExecution";
ALTER TABLE "new_DirectorRuntimeExecution" RENAME TO "DirectorRuntimeExecution";
CREATE UNIQUE INDEX "DirectorRuntimeExecution_activeLockKey_key" ON "DirectorRuntimeExecution"("activeLockKey");
CREATE INDEX "DirectorRuntimeExecution_runtimeId_status_updatedAt_idx" ON "DirectorRuntimeExecution"("runtimeId", "status", "updatedAt");
CREATE INDEX "DirectorRuntimeExecution_status_leaseExpiresAt_idx" ON "DirectorRuntimeExecution"("status", "leaseExpiresAt");
CREATE INDEX "DirectorRuntimeExecution_workflowTaskId_status_updatedAt_idx" ON "DirectorRuntimeExecution"("workflowTaskId", "status", "updatedAt");
CREATE INDEX "DirectorRuntimeExecution_novelId_status_updatedAt_idx" ON "DirectorRuntimeExecution"("novelId", "status", "updatedAt");
CREATE INDEX "DirectorRuntimeExecution_workerId_status_updatedAt_idx" ON "DirectorRuntimeExecution"("workerId", "status", "updatedAt");
CREATE TABLE "new_DirectorRuntimeInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT,
    "workflowTaskId" TEXT,
    "runId" TEXT,
    "runMode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting_worker',
    "currentStep" TEXT,
    "currentChapterId" TEXT,
    "checkpointVersion" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" DATETIME,
    "lastHeartbeatAt" DATETIME,
    "lastErrorClass" TEXT,
    "lastErrorMessage" TEXT,
    "workerMessage" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_DirectorRuntimeInstance" ("cancelRequestedAt", "checkpointVersion", "createdAt", "currentChapterId", "currentStep", "id", "lastErrorClass", "lastErrorMessage", "lastHeartbeatAt", "metadataJson", "novelId", "runId", "runMode", "status", "updatedAt", "workerMessage", "workflowTaskId") SELECT "cancelRequestedAt", "checkpointVersion", "createdAt", "currentChapterId", "currentStep", "id", "lastErrorClass", "lastErrorMessage", "lastHeartbeatAt", "metadataJson", "novelId", "runId", "runMode", "status", "updatedAt", "workerMessage", "workflowTaskId" FROM "DirectorRuntimeInstance";
DROP TABLE "DirectorRuntimeInstance";
ALTER TABLE "new_DirectorRuntimeInstance" RENAME TO "DirectorRuntimeInstance";
CREATE INDEX "DirectorRuntimeInstance_novelId_status_updatedAt_idx" ON "DirectorRuntimeInstance"("novelId", "status", "updatedAt");
CREATE INDEX "DirectorRuntimeInstance_workflowTaskId_idx" ON "DirectorRuntimeInstance"("workflowTaskId");
CREATE INDEX "DirectorRuntimeInstance_runId_idx" ON "DirectorRuntimeInstance"("runId");
CREATE INDEX "DirectorRuntimeInstance_status_updatedAt_idx" ON "DirectorRuntimeInstance"("status", "updatedAt");
CREATE TABLE "new_DramaBatchJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DramaBatchJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DramaProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DramaBatchJob_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "DramaEpisode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DramaBatchJob" ("createdAt", "episodeId", "id", "progress", "projectId", "status", "type", "updatedAt") SELECT "createdAt", "episodeId", "id", "progress", "projectId", "status", "type", "updatedAt" FROM "DramaBatchJob";
DROP TABLE "DramaBatchJob";
ALTER TABLE "new_DramaBatchJob" RENAME TO "DramaBatchJob";
CREATE INDEX "DramaBatchJob_projectId_createdAt_idx" ON "DramaBatchJob"("projectId", "createdAt");
CREATE INDEX "DramaBatchJob_episodeId_status_idx" ON "DramaBatchJob"("episodeId", "status");
CREATE INDEX "DramaBatchJob_type_status_idx" ON "DramaBatchJob"("type", "status");
CREATE TABLE "new_DramaCharacter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archetype" TEXT,
    "persona" TEXT,
    "speechStyle" TEXT,
    "visualAnchor" TEXT,
    "voiceProfile" TEXT,
    "relations" TEXT,
    "sourceCharacterRef" TEXT,
    "portraitData" TEXT,
    "threeViewData" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DramaCharacter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DramaProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DramaCharacter" ("archetype", "createdAt", "id", "name", "persona", "projectId", "relations", "sourceCharacterRef", "speechStyle", "updatedAt", "visualAnchor", "voiceProfile") SELECT "archetype", "createdAt", "id", "name", "persona", "projectId", "relations", "sourceCharacterRef", "speechStyle", "updatedAt", "visualAnchor", "voiceProfile" FROM "DramaCharacter";
DROP TABLE "DramaCharacter";
ALTER TABLE "new_DramaCharacter" RENAME TO "DramaCharacter";
CREATE INDEX "DramaCharacter_projectId_idx" ON "DramaCharacter"("projectId");
CREATE TABLE "new_DramaCharacterLibrary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "archetype" TEXT,
    "persona" TEXT,
    "speechStyle" TEXT,
    "visualAnchor" TEXT,
    "voiceProfile" TEXT,
    "relations" TEXT,
    "tags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DramaCharacterLibrary_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DramaProject" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DramaCharacterLibrary" ("archetype", "createdAt", "id", "name", "persona", "projectId", "relations", "speechStyle", "tags", "updatedAt", "visualAnchor", "voiceProfile") SELECT "archetype", "createdAt", "id", "name", "persona", "projectId", "relations", "speechStyle", "tags", "updatedAt", "visualAnchor", "voiceProfile" FROM "DramaCharacterLibrary";
DROP TABLE "DramaCharacterLibrary";
ALTER TABLE "new_DramaCharacterLibrary" RENAME TO "DramaCharacterLibrary";
CREATE INDEX "DramaCharacterLibrary_projectId_idx" ON "DramaCharacterLibrary"("projectId");
CREATE INDEX "DramaCharacterLibrary_name_idx" ON "DramaCharacterLibrary"("name");
CREATE TABLE "new_DramaEpisode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT DEFAULT '',
    "hookOpening" TEXT,
    "cliffhanger" TEXT,
    "hookType" TEXT,
    "isPaywall" BOOLEAN NOT NULL DEFAULT false,
    "emotionNet" INTEGER,
    "beatSheet" TEXT,
    "sourceMap" TEXT,
    "durationSec" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "qualityFlags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DramaEpisode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DramaProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DramaEpisode" ("beatSheet", "cliffhanger", "content", "createdAt", "durationSec", "emotionNet", "hookOpening", "hookType", "id", "isPaywall", "order", "projectId", "qualityFlags", "sourceMap", "status", "title", "updatedAt") SELECT "beatSheet", "cliffhanger", "content", "createdAt", "durationSec", "emotionNet", "hookOpening", "hookType", "id", "isPaywall", "order", "projectId", "qualityFlags", "sourceMap", "status", "title", "updatedAt" FROM "DramaEpisode";
DROP TABLE "DramaEpisode";
ALTER TABLE "new_DramaEpisode" RENAME TO "DramaEpisode";
CREATE INDEX "DramaEpisode_projectId_status_idx" ON "DramaEpisode"("projectId", "status");
CREATE UNIQUE INDEX "DramaEpisode_projectId_order_key" ON "DramaEpisode"("projectId", "order");
CREATE TABLE "new_DramaProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'original',
    "sourceRef" TEXT,
    "sourceInput" TEXT,
    "track" TEXT,
    "theme" TEXT,
    "orientation" TEXT NOT NULL DEFAULT 'vertical_paid',
    "targetEpisodes" INTEGER NOT NULL DEFAULT 80,
    "strategy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_DramaProject" ("createdAt", "id", "orientation", "source", "sourceInput", "sourceRef", "status", "strategy", "targetEpisodes", "theme", "title", "track", "updatedAt") SELECT "createdAt", "id", "orientation", "source", "sourceInput", "sourceRef", "status", "strategy", "targetEpisodes", "theme", "title", "track", "updatedAt" FROM "DramaProject";
DROP TABLE "DramaProject";
ALTER TABLE "new_DramaProject" RENAME TO "DramaProject";
CREATE INDEX "DramaProject_source_idx" ON "DramaProject"("source");
CREATE INDEX "DramaProject_status_idx" ON "DramaProject"("status");
CREATE TABLE "new_DramaShot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storyboardId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "shotSize" TEXT,
    "cameraMove" TEXT,
    "durationSec" INTEGER,
    "location" TEXT,
    "action" TEXT NOT NULL,
    "dialogue" TEXT,
    "characterRefs" TEXT,
    "visualPrompt" TEXT,
    "keyframeData" TEXT,
    "dialogueAudioData" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DramaShot_storyboardId_fkey" FOREIGN KEY ("storyboardId") REFERENCES "DramaStoryboard" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DramaShot" ("action", "cameraMove", "characterRefs", "createdAt", "dialogue", "dialogueAudioData", "durationSec", "id", "keyframeData", "location", "order", "shotSize", "storyboardId", "updatedAt", "visualPrompt") SELECT "action", "cameraMove", "characterRefs", "createdAt", "dialogue", "dialogueAudioData", "durationSec", "id", "keyframeData", "location", "order", "shotSize", "storyboardId", "updatedAt", "visualPrompt" FROM "DramaShot";
DROP TABLE "DramaShot";
ALTER TABLE "new_DramaShot" RENAME TO "DramaShot";
CREATE INDEX "DramaShot_storyboardId_idx" ON "DramaShot"("storyboardId");
CREATE UNIQUE INDEX "DramaShot_storyboardId_order_key" ON "DramaShot"("storyboardId", "order");
CREATE TABLE "new_DramaSourceBundle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "synopsis" TEXT,
    "beats" TEXT,
    "worldNotes" TEXT,
    "hardFacts" TEXT,
    "rawText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DramaSourceBundle_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DramaProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DramaSourceBundle" ("beats", "createdAt", "hardFacts", "id", "projectId", "rawText", "synopsis", "updatedAt", "worldNotes") SELECT "beats", "createdAt", "hardFacts", "id", "projectId", "rawText", "synopsis", "updatedAt", "worldNotes" FROM "DramaSourceBundle";
DROP TABLE "DramaSourceBundle";
ALTER TABLE "new_DramaSourceBundle" RENAME TO "DramaSourceBundle";
CREATE UNIQUE INDEX "DramaSourceBundle_projectId_key" ON "DramaSourceBundle"("projectId");
CREATE TABLE "new_DramaStoryboard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "summary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DramaStoryboard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DramaProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DramaStoryboard_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "DramaEpisode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DramaStoryboard" ("createdAt", "episodeId", "id", "projectId", "status", "summary", "updatedAt", "version") SELECT "createdAt", "episodeId", "id", "projectId", "status", "summary", "updatedAt", "version" FROM "DramaStoryboard";
DROP TABLE "DramaStoryboard";
ALTER TABLE "new_DramaStoryboard" RENAME TO "DramaStoryboard";
CREATE INDEX "DramaStoryboard_projectId_idx" ON "DramaStoryboard"("projectId");
CREATE INDEX "DramaStoryboard_episodeId_idx" ON "DramaStoryboard"("episodeId");
CREATE TABLE "new_DramaVideoPrompt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "shotId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "aspectRatio" TEXT NOT NULL DEFAULT '9:16',
    "durationSec" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'prompted',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "providerTaskId" TEXT,
    "resultUrl" TEXT,
    "failureReason" TEXT,
    "providerResult" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DramaVideoPrompt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DramaProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DramaVideoPrompt_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "DramaEpisode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DramaVideoPrompt" ("aspectRatio", "createdAt", "durationSec", "episodeId", "failureReason", "id", "negativePrompt", "projectId", "prompt", "provider", "providerResult", "providerTaskId", "resultUrl", "shotId", "status", "supersededById", "updatedAt", "version") SELECT "aspectRatio", "createdAt", "durationSec", "episodeId", "failureReason", "id", "negativePrompt", "projectId", "prompt", "provider", "providerResult", "providerTaskId", "resultUrl", "shotId", "status", "supersededById", "updatedAt", "version" FROM "DramaVideoPrompt";
DROP TABLE "DramaVideoPrompt";
ALTER TABLE "new_DramaVideoPrompt" RENAME TO "DramaVideoPrompt";
CREATE INDEX "DramaVideoPrompt_projectId_idx" ON "DramaVideoPrompt"("projectId");
CREATE INDEX "DramaVideoPrompt_episodeId_idx" ON "DramaVideoPrompt"("episodeId");
CREATE INDEX "DramaVideoPrompt_projectId_shotId_version_idx" ON "DramaVideoPrompt"("projectId", "shotId", "version");
CREATE INDEX "DramaVideoPrompt_provider_status_idx" ON "DramaVideoPrompt"("provider", "status");
CREATE TABLE "new_Novel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "targetAudience" TEXT,
    "bookSellingPoint" TEXT,
    "competingFeel" TEXT,
    "first30ChapterPromise" TEXT,
    "commercialTagsJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "writingMode" TEXT NOT NULL DEFAULT 'original',
    "projectMode" TEXT,
    "narrativePov" TEXT,
    "pacePreference" TEXT,
    "styleTone" TEXT,
    "audiobookNarratorVoice" TEXT,
    "audiobookNarratorStyle" TEXT,
    "emotionIntensity" TEXT,
    "aiFreedom" TEXT,
    "postGenerationStyleReviewEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultChapterLength" INTEGER,
    "estimatedChapterCount" INTEGER,
    "projectStatus" TEXT DEFAULT 'not_started',
    "storylineStatus" TEXT DEFAULT 'not_started',
    "outlineStatus" TEXT DEFAULT 'not_started',
    "resourceReadyScore" INTEGER,
    "sourceNovelId" TEXT,
    "sourceKnowledgeDocumentId" TEXT,
    "continuationBookAnalysisId" TEXT,
    "continuationBookAnalysisSections" TEXT,
    "outline" TEXT,
    "structuredOutline" TEXT,
    "storyWorldSliceJson" TEXT,
    "storyWorldSliceOverridesJson" TEXT,
    "storyWorldSliceSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "genreId" TEXT,
    "primaryStoryModeId" TEXT,
    "secondaryStoryModeId" TEXT,
    "worldId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Novel_genreId_fkey" FOREIGN KEY ("genreId") REFERENCES "NovelGenre" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Novel_primaryStoryModeId_fkey" FOREIGN KEY ("primaryStoryModeId") REFERENCES "NovelStoryMode" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Novel_secondaryStoryModeId_fkey" FOREIGN KEY ("secondaryStoryModeId") REFERENCES "NovelStoryMode" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Novel_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Novel_sourceNovelId_fkey" FOREIGN KEY ("sourceNovelId") REFERENCES "Novel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Novel_sourceKnowledgeDocumentId_fkey" FOREIGN KEY ("sourceKnowledgeDocumentId") REFERENCES "KnowledgeDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Novel_continuationBookAnalysisId_fkey" FOREIGN KEY ("continuationBookAnalysisId") REFERENCES "BookAnalysis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Novel" ("aiFreedom", "audiobookNarratorStyle", "audiobookNarratorVoice", "bookSellingPoint", "commercialTagsJson", "competingFeel", "continuationBookAnalysisId", "continuationBookAnalysisSections", "createdAt", "defaultChapterLength", "description", "emotionIntensity", "estimatedChapterCount", "first30ChapterPromise", "genreId", "id", "narrativePov", "outline", "outlineStatus", "pacePreference", "postGenerationStyleReviewEnabled", "primaryStoryModeId", "projectMode", "projectStatus", "resourceReadyScore", "secondaryStoryModeId", "sourceKnowledgeDocumentId", "sourceNovelId", "status", "storyWorldSliceJson", "storyWorldSliceOverridesJson", "storyWorldSliceSchemaVersion", "storylineStatus", "structuredOutline", "styleTone", "targetAudience", "title", "updatedAt", "worldId", "writingMode") SELECT "aiFreedom", "audiobookNarratorStyle", "audiobookNarratorVoice", "bookSellingPoint", "commercialTagsJson", "competingFeel", "continuationBookAnalysisId", "continuationBookAnalysisSections", "createdAt", "defaultChapterLength", "description", "emotionIntensity", "estimatedChapterCount", "first30ChapterPromise", "genreId", "id", "narrativePov", "outline", "outlineStatus", "pacePreference", "postGenerationStyleReviewEnabled", "primaryStoryModeId", "projectMode", "projectStatus", "resourceReadyScore", "secondaryStoryModeId", "sourceKnowledgeDocumentId", "sourceNovelId", "status", "storyWorldSliceJson", "storyWorldSliceOverridesJson", "storyWorldSliceSchemaVersion", "storylineStatus", "structuredOutline", "styleTone", "targetAudience", "title", "updatedAt", "worldId", "writingMode" FROM "Novel";
DROP TABLE "Novel";
ALTER TABLE "new_Novel" RENAME TO "Novel";
CREATE INDEX "Novel_genreId_idx" ON "Novel"("genreId");
CREATE INDEX "Novel_primaryStoryModeId_idx" ON "Novel"("primaryStoryModeId");
CREATE INDEX "Novel_secondaryStoryModeId_idx" ON "Novel"("secondaryStoryModeId");
CREATE INDEX "Novel_worldId_idx" ON "Novel"("worldId");
CREATE INDEX "Novel_writingMode_idx" ON "Novel"("writingMode");
CREATE INDEX "Novel_sourceNovelId_idx" ON "Novel"("sourceNovelId");
CREATE INDEX "Novel_sourceKnowledgeDocumentId_idx" ON "Novel"("sourceKnowledgeDocumentId");
CREATE INDEX "Novel_continuationBookAnalysisId_idx" ON "Novel"("continuationBookAnalysisId");
CREATE TABLE "new_NovelSideEffectJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payloadJson" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "lastError" TEXT,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NovelSideEffectJob_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NovelSideEffectJob" ("attempts", "createdAt", "finishedAt", "id", "idempotencyKey", "jobType", "lastError", "leaseExpiresAt", "leaseOwner", "maxAttempts", "novelId", "payloadJson", "payloadVersion", "runAfter", "status", "updatedAt") SELECT "attempts", "createdAt", "finishedAt", "id", "idempotencyKey", "jobType", "lastError", "leaseExpiresAt", "leaseOwner", "maxAttempts", "novelId", "payloadJson", "payloadVersion", "runAfter", "status", "updatedAt" FROM "NovelSideEffectJob";
DROP TABLE "NovelSideEffectJob";
ALTER TABLE "new_NovelSideEffectJob" RENAME TO "NovelSideEffectJob";
CREATE UNIQUE INDEX "NovelSideEffectJob_idempotencyKey_key" ON "NovelSideEffectJob"("idempotencyKey");
CREATE INDEX "NovelSideEffectJob_status_runAfter_idx" ON "NovelSideEffectJob"("status", "runAfter");
CREATE INDEX "NovelSideEffectJob_novelId_status_updatedAt_idx" ON "NovelSideEffectJob"("novelId", "status", "updatedAt");
CREATE INDEX "NovelSideEffectJob_leaseOwner_leaseExpiresAt_idx" ON "NovelSideEffectJob"("leaseOwner", "leaseExpiresAt");
CREATE INDEX "NovelSideEffectJob_jobType_status_runAfter_idx" ON "NovelSideEffectJob"("jobType", "status", "runAfter");
CREATE TABLE "new_NovelWorkflowTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT,
    "lane" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" REAL NOT NULL DEFAULT 0,
    "currentStage" TEXT,
    "currentItemKey" TEXT,
    "currentItemLabel" TEXT,
    "checkpointType" TEXT,
    "checkpointSummary" TEXT,
    "resumeTargetJson" TEXT,
    "seedPayloadJson" TEXT,
    "milestonesJson" TEXT,
    "pendingManualRecovery" BOOLEAN NOT NULL DEFAULT false,
    "heartbeatAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "cancelRequestedAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "ownershipVersion" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "llmCallCount" INTEGER NOT NULL DEFAULT 0,
    "lastTokenRecordedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NovelWorkflowTask_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NovelWorkflowTask" ("attemptCount", "cancelRequestedAt", "checkpointSummary", "checkpointType", "completionTokens", "createdAt", "currentItemKey", "currentItemLabel", "currentStage", "finishedAt", "heartbeatAt", "id", "lane", "lastError", "lastTokenRecordedAt", "llmCallCount", "maxAttempts", "milestonesJson", "novelId", "ownershipVersion", "pendingManualRecovery", "progress", "promptTokens", "resumeTargetJson", "seedPayloadJson", "startedAt", "status", "title", "totalTokens", "updatedAt") SELECT "attemptCount", "cancelRequestedAt", "checkpointSummary", "checkpointType", "completionTokens", "createdAt", "currentItemKey", "currentItemLabel", "currentStage", "finishedAt", "heartbeatAt", "id", "lane", "lastError", "lastTokenRecordedAt", "llmCallCount", "maxAttempts", "milestonesJson", "novelId", "ownershipVersion", "pendingManualRecovery", "progress", "promptTokens", "resumeTargetJson", "seedPayloadJson", "startedAt", "status", "title", "totalTokens", "updatedAt" FROM "NovelWorkflowTask";
DROP TABLE "NovelWorkflowTask";
ALTER TABLE "new_NovelWorkflowTask" RENAME TO "NovelWorkflowTask";
CREATE INDEX "NovelWorkflowTask_novelId_status_updatedAt_idx" ON "NovelWorkflowTask"("novelId", "status", "updatedAt");
CREATE INDEX "NovelWorkflowTask_status_updatedAt_idx" ON "NovelWorkflowTask"("status", "updatedAt");
CREATE INDEX "NovelWorkflowTask_lane_updatedAt_idx" ON "NovelWorkflowTask"("lane", "updatedAt");
CREATE TABLE "new_NovelWorld" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT NOT NULL,
    "sourceWorldId" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "title" TEXT,
    "coverSummary" TEXT,
    "structuredDataJson" TEXT,
    "bindingContractJson" TEXT,
    "storySliceJson" TEXT,
    "storySliceOverridesJson" TEXT,
    "storySliceSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "storySliceBuiltAt" DATETIME,
    "storySliceDigest" TEXT,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncDirection" TEXT NOT NULL DEFAULT 'none',
    "syncBaseVersion" INTEGER,
    "syncPendingChangesJson" TEXT,
    "lastSyncedAt" DATETIME,
    "generationPolicyJson" TEXT,
    "generatedFromThemeJson" TEXT,
    "savedToLibraryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NovelWorld_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NovelWorld_sourceWorldId_fkey" FOREIGN KEY ("sourceWorldId") REFERENCES "World" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_NovelWorld" ("bindingContractJson", "coverSummary", "createdAt", "generatedFromThemeJson", "generationPolicyJson", "id", "lastSyncedAt", "novelId", "savedToLibraryAt", "sourceType", "sourceWorldId", "storySliceBuiltAt", "storySliceDigest", "storySliceJson", "storySliceOverridesJson", "storySliceSchemaVersion", "structuredDataJson", "syncBaseVersion", "syncDirection", "syncEnabled", "syncPendingChangesJson", "title", "updatedAt") SELECT "bindingContractJson", "coverSummary", "createdAt", "generatedFromThemeJson", "generationPolicyJson", "id", "lastSyncedAt", "novelId", "savedToLibraryAt", "sourceType", "sourceWorldId", "storySliceBuiltAt", "storySliceDigest", "storySliceJson", "storySliceOverridesJson", "storySliceSchemaVersion", "structuredDataJson", "syncBaseVersion", "syncDirection", "syncEnabled", "syncPendingChangesJson", "title", "updatedAt" FROM "NovelWorld";
DROP TABLE "NovelWorld";
ALTER TABLE "new_NovelWorld" RENAME TO "NovelWorld";
CREATE UNIQUE INDEX "NovelWorld_novelId_key" ON "NovelWorld"("novelId");
CREATE INDEX "NovelWorld_sourceWorldId_idx" ON "NovelWorld"("sourceWorldId");
CREATE INDEX "NovelWorld_sourceType_idx" ON "NovelWorld"("sourceType");
CREATE TABLE "new_VolumeChapterPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "volumeId" TEXT NOT NULL,
    "chapterId" TEXT,
    "chapterOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "purpose" TEXT,
    "conflictLevel" INTEGER,
    "conflictLevelSource" TEXT,
    "revealLevel" INTEGER,
    "targetWordCount" INTEGER,
    "mustAvoid" TEXT,
    "taskSheet" TEXT,
    "sceneCards" TEXT,
    "payoffRefsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VolumeChapterPlan_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "VolumePlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VolumeChapterPlan_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_VolumeChapterPlan" ("chapterId", "chapterOrder", "conflictLevel", "conflictLevelSource", "createdAt", "id", "mustAvoid", "payoffRefsJson", "purpose", "revealLevel", "sceneCards", "summary", "targetWordCount", "taskSheet", "title", "updatedAt", "volumeId") SELECT "chapterId", "chapterOrder", "conflictLevel", "conflictLevelSource", "createdAt", "id", "mustAvoid", "payoffRefsJson", "purpose", "revealLevel", "sceneCards", "summary", "targetWordCount", "taskSheet", "title", "updatedAt", "volumeId" FROM "VolumeChapterPlan";
DROP TABLE "VolumeChapterPlan";
ALTER TABLE "new_VolumeChapterPlan" RENAME TO "VolumeChapterPlan";
CREATE INDEX "VolumeChapterPlan_volumeId_chapterOrder_idx" ON "VolumeChapterPlan"("volumeId", "chapterOrder");
CREATE INDEX "VolumeChapterPlan_chapterId_idx" ON "VolumeChapterPlan"("chapterId");
CREATE UNIQUE INDEX "VolumeChapterPlan_volumeId_chapterOrder_key" ON "VolumeChapterPlan"("volumeId", "chapterOrder");
CREATE TABLE "new_WorldAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "worldId" TEXT,
    "novelWorldId" TEXT,
    "assetType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "generationPrompt" TEXT,
    "renderDataJson" TEXT,
    "thumbnailUrl" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'placeholder',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorldAsset_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorldAsset_novelWorldId_fkey" FOREIGN KEY ("novelWorldId") REFERENCES "NovelWorld" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorldAsset" ("assetType", "createdAt", "description", "generationPrompt", "id", "novelWorldId", "renderDataJson", "status", "thumbnailUrl", "title", "updatedAt", "version", "worldId") SELECT "assetType", "createdAt", "description", "generationPrompt", "id", "novelWorldId", "renderDataJson", "status", "thumbnailUrl", "title", "updatedAt", "version", "worldId" FROM "WorldAsset";
DROP TABLE "WorldAsset";
ALTER TABLE "new_WorldAsset" RENAME TO "WorldAsset";
CREATE INDEX "WorldAsset_worldId_assetType_idx" ON "WorldAsset"("worldId", "assetType");
CREATE INDEX "WorldAsset_novelWorldId_assetType_idx" ON "WorldAsset"("novelWorldId", "assetType");
CREATE INDEX "WorldAsset_assetType_idx" ON "WorldAsset"("assetType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PromptSlotOverride_promptId_idx" ON "PromptSlotOverride"("promptId");

-- CreateIndex
CREATE INDEX "PromptSlotOverride_novelId_promptId_idx" ON "PromptSlotOverride"("novelId", "promptId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptSlotOverride_scope_novelId_promptId_key" ON "PromptSlotOverride"("scope", "novelId", "promptId");

-- CreateIndex
CREATE UNIQUE INDEX "M4bEncodingJob_audiobookTaskId_key" ON "M4bEncodingJob"("audiobookTaskId");

-- CreateIndex
CREATE INDEX "M4bEncodingJob_status_createdAt_idx" ON "M4bEncodingJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ComicCharacterAsset_characterId_idx" ON "ComicCharacterAsset"("characterId");

-- CreateIndex
CREATE INDEX "ComicCharacterAsset_projectId_idx" ON "ComicCharacterAsset"("projectId");

-- CreateIndex
CREATE INDEX "ComicScene_projectId_idx" ON "ComicScene"("projectId");

-- CreateIndex
CREATE INDEX "AutoDirectorFollowUpNotificationLog_channelType_readAt_idx" ON "AutoDirectorFollowUpNotificationLog"("channelType", "readAt");

-- RedefineIndex
DROP INDEX "BookAnalysisSourceCache_scope_unique";
CREATE UNIQUE INDEX "BookAnalysisSourceCache_documentVersionId_sourceScopeKey_provider_model_temperature_notesMaxTokens_segmentVersion_key" ON "BookAnalysisSourceCache"("documentVersionId", "sourceScopeKey", "provider", "model", "temperature", "notesMaxTokens", "segmentVersion");
