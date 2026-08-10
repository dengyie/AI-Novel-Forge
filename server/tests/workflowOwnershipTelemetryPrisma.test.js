const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");

test("tracked LLM usage does not invalidate a real Prisma workflow ownership claim", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-ownership-telemetry-"));
  try {
    const databasePath = path.join(tempDir, "ownership.db");
    const databaseUrl = `file:${databasePath.replace(/\\/g, "/")}`;
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE "Novel" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL
      );
      CREATE TABLE "NovelWorkflowTask" (
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
        "updatedAt" DATETIME NOT NULL
      );
    `);
    database.close();

    const scriptPath = path.join(tempDir, "run.cjs");
    fs.writeFileSync(scriptPath, `
const assert = require("node:assert/strict");
const path = require("node:path");

async function main() {
  const root = process.cwd();
  global.prisma = undefined;
  const { prisma } = require(path.join(root, "server/dist/db/prisma.js"));
  const { runWithLlmUsageTracking, recordTrackedLlmUsage } = require(path.join(root, "server/dist/llm/usageTracking.js"));
  const { NovelWorkflowService } = require(path.join(root, "server/dist/services/novel/workflow/NovelWorkflowService.js"));
  const { AutoExecutionOwnershipFence } = require(path.join(root, "server/dist/services/novel/director/automation/domain/AutoExecutionOwnershipFence.js"));
  const { StateCommitService } = require(path.join(root, "server/dist/services/novel/state/StateCommitService.js"));

  const workflowService = new NovelWorkflowService();
  workflowService.getTaskByIdWithoutHealing = (taskId) => prisma.novelWorkflowTask.findUnique({ where: { id: taskId } });
  workflowService.notifyAutoDirectorTaskTransition = async () => undefined;
  const task = await prisma.novelWorkflowTask.create({
    data: {
      lane: "auto_director",
      title: "ownership telemetry fixture",
      status: "running",
      attemptCount: 2,
    },
  });
  const fence = new AutoExecutionOwnershipFence({
    workflowService,
    novelService: { cancelPipelineJob: async () => undefined },
  }, task.id);

  const before = await fence.assertActive();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await runWithLlmUsageTracking({ workflowTaskId: task.id }, () => recordTrackedLlmUsage({
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  }));
  const afterUsage = await prisma.novelWorkflowTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(afterUsage.ownershipVersion, before.ownershipVersion);
  assert.ok(afterUsage.updatedAt.getTime() >= task.updatedAt.getTime());

  const checkpoint = await fence.runOwnedWrite((ownership) => workflowService.recordCheckpoint(task.id, {
    stage: "quality_repair",
    checkpointType: "chapter_batch_ready",
    checkpointSummary: "telemetry must not revoke the current attempt",
    itemLabel: "ownership retained",
  }, ownership));
  assert.equal(checkpoint.ownershipVersion, before.ownershipVersion + 1);

  const promotionTask = await prisma.novelWorkflowTask.create({
    data: {
      lane: "auto_director",
      title: "promotion ownership fixture",
      status: "running",
      attemptCount: 1,
    },
  });
  const stalePromotionOwnership = {
    taskId: promotionTask.id,
    attemptCount: promotionTask.attemptCount,
    ownershipVersion: promotionTask.ownershipVersion,
  };
  await prisma.novelWorkflowTask.update({
    where: { id: promotionTask.id },
    data: {
      status: "cancelled",
      cancelRequestedAt: new Date(),
      ownershipVersion: { increment: 1 },
    },
  });
  await assert.rejects(() => new StateCommitService().commitExistingProposals({
    novelId: "novel-1",
    proposalIds: ["proposal-must-not-commit"],
    reason: "ownership-race-regression",
    ownership: stalePromotionOwnership,
  }), (error) => error?.code === "WORKFLOW_TASK_OWNERSHIP_LOST");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`, "utf8");

    const result = childProcess.spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
