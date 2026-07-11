const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");

function pnpmExecutable() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "task-retention-runonce.db");
  const databaseUrl = `file:${databasePath.replace(/\\/g, "/")}`;
  childProcess.execFileSync(pnpmExecutable(), ["--filter", "@ai-novel/server", "prisma:push"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return databaseUrl;
}

function writeChildScript(tempDir) {
  const scriptPath = path.join(tempDir, "run-task-retention-once.cjs");
  const script = `
const path = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs");

async function main() {
  const repoRoot = process.cwd();
  const resultPath = process.env.TASK_RETENTION_RESULT_PATH;
  if (!resultPath) {
    throw new Error("TASK_RETENTION_RESULT_PATH is required");
  }

  global.prisma = undefined;

  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const { TaskRetentionService } = require(path.join(repoRoot, "server", "dist", "services", "task", "TaskRetentionService.js"));

  const now = new Date("2026-07-01T00:00:00.000Z");
  const dayMs = 24 * 60 * 60 * 1000;
  const age = (days) => new Date(now.getTime() - days * dayMs);

  // --- Novel A: active takeover → supersede terminals (+ zombie cancel→supersede) ---
  const novelA = await prisma.novel.create({
    data: {
      title: "retention-supersede",
      description: "active takeover fixture",
      outline: "fixture",
      estimatedChapterCount: 3,
    },
  });

  const activeTask = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novelA.id,
      lane: "auto_director",
      title: "active-director",
      status: "running",
      heartbeatAt: now,
      updatedAt: now,
    },
  });

  const supersededFailed = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novelA.id,
      lane: "auto_director",
      title: "superseded-failed",
      status: "failed",
      finishedAt: age(2),
      updatedAt: age(2),
      lastError: "old failure",
    },
  });

  const zombie = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novelA.id,
      lane: "auto_director",
      title: "zombie-running",
      status: "running",
      pendingManualRecovery: false,
      cancelRequestedAt: null,
      heartbeatAt: age(1),
      updatedAt: age(1),
      currentItemKey: "quality_repair",
    },
  });

  const runtime = await prisma.directorRuntimeInstance.create({
    data: {
      novelId: novelA.id,
      workflowTaskId: supersededFailed.id,
      status: "failed",
    },
  });
  await prisma.directorRuntimeEvent.create({
    data: {
      id: "evt-superseded-1",
      runtimeId: runtime.id,
      workflowTaskId: supersededFailed.id,
      novelId: novelA.id,
      type: "command.failed",
      summary: "old failure",
      occurredAt: age(2),
    },
  });
  await prisma.autoDirectorFollowUpActionLog.create({
    data: {
      taskId: supersededFailed.id,
      actionCode: "retry",
      sourceChannel: "test",
      idempotencyKey: "action-superseded-1",
      resultCode: "ok",
    },
  });
  await prisma.autoDirectorFollowUpNotificationLog.create({
    data: {
      eventId: "notif-superseded-1",
      eventType: "auto_director.exception",
      taskId: supersededFailed.id,
      channelType: "wecom",
      status: "delivered",
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "novel_workflow",
      taskId: supersededFailed.id,
    },
  });

  // Orphan follow-up logs (task already gone) must be deleted via NOT EXISTS.
  await prisma.autoDirectorFollowUpActionLog.create({
    data: {
      taskId: "missing-task-orphan",
      actionCode: "resume",
      sourceChannel: "test",
      idempotencyKey: "action-orphan-1",
      resultCode: "ok",
    },
  });
  await prisma.autoDirectorFollowUpNotificationLog.create({
    data: {
      eventId: "notif-orphan-1",
      eventType: "auto_director.exception",
      taskId: "missing-task-orphan",
      channelType: "wecom",
      status: "failed",
    },
  });

  // --- Novel B: no active takeover → age window only (keepPerNovel=2, succeededDays=1) ---
  const novelB = await prisma.novel.create({
    data: {
      title: "retention-age",
      description: "age window fixture",
      outline: "fixture",
      estimatedChapterCount: 1,
    },
  });
  const ageKeepRecent = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novelB.id,
      lane: "auto_director",
      title: "age-keep-recent",
      status: "succeeded",
      finishedAt: age(0.5),
      updatedAt: age(0.5),
    },
  });
  const ageKeepMid = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novelB.id,
      lane: "auto_director",
      title: "age-keep-mid",
      status: "succeeded",
      finishedAt: age(0.8),
      updatedAt: age(0.8),
    },
  });
  const ageDeleteOld = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novelB.id,
      lane: "auto_director",
      title: "age-delete-old",
      status: "succeeded",
      finishedAt: age(3),
      updatedAt: age(3),
    },
  });

  // --- Novel C: isolated single failed without takeover → keep ---
  const novelC = await prisma.novel.create({
    data: {
      title: "retention-isolated",
      description: "no active takeover",
      outline: "fixture",
      estimatedChapterCount: 1,
    },
  });
  const isolatedFailed = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novelC.id,
      lane: "auto_director",
      title: "isolated-failed",
      status: "failed",
      finishedAt: age(2),
      updatedAt: age(2),
      lastError: "keep me",
    },
  });

  // --- Pipeline on novel A: supersede + age ---
  const activePipeline = await prisma.generationJob.create({
    data: {
      novelId: novelA.id,
      startOrder: 1,
      endOrder: 3,
      status: "running",
      totalCount: 3,
      heartbeatAt: now,
      updatedAt: now,
    },
  });
  const oldPipelineFailed = await prisma.generationJob.create({
    data: {
      novelId: novelA.id,
      startOrder: 1,
      endOrder: 3,
      status: "failed",
      totalCount: 3,
      finishedAt: age(2),
      updatedAt: age(2),
      error: "old pipeline failure",
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "novel_pipeline",
      taskId: oldPipelineFailed.id,
    },
  });

  // Pipeline age on novel B (no active pipeline; also no auto_director active after we only put terminals there)
  const pipeKeepA = await prisma.generationJob.create({
    data: {
      novelId: novelB.id,
      startOrder: 1,
      endOrder: 1,
      status: "succeeded",
      totalCount: 1,
      finishedAt: age(0.2),
      updatedAt: age(0.2),
    },
  });
  const pipeKeepB = await prisma.generationJob.create({
    data: {
      novelId: novelB.id,
      startOrder: 2,
      endOrder: 2,
      status: "succeeded",
      totalCount: 1,
      finishedAt: age(0.4),
      updatedAt: age(0.4),
    },
  });
  const pipeAgeDelete = await prisma.generationJob.create({
    data: {
      novelId: novelB.id,
      startOrder: 3,
      endOrder: 3,
      status: "succeeded",
      totalCount: 1,
      finishedAt: age(5),
      updatedAt: age(5),
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "novel_pipeline",
      taskId: pipeAgeDelete.id,
    },
  });

  const service = new TaskRetentionService();
  const summary = await service.runOnce(now);

  const remainingWorkflow = await prisma.novelWorkflowTask.findMany({
    select: { id: true, status: true, title: true },
  });
  const remainingPipeline = await prisma.generationJob.findMany({
    select: { id: true, status: true },
  });
  const remainingActionLogs = await prisma.autoDirectorFollowUpActionLog.count();
  const remainingNotificationLogs = await prisma.autoDirectorFollowUpNotificationLog.count();
  const remainingRuntimeEvents = await prisma.directorRuntimeEvent.count();
  const remainingArchives = await prisma.taskCenterArchive.count();

  const workflowIds = new Set(remainingWorkflow.map((row) => row.id));
  const pipelineIds = new Set(remainingPipeline.map((row) => row.id));

  assert.equal(workflowIds.has(activeTask.id), true, "active director task must remain");
  assert.equal(workflowIds.has(supersededFailed.id), false, "superseded failed workflow must be deleted");
  assert.equal(
    workflowIds.has(zombie.id),
    false,
    "zombie cancelled under active takeover is supersede-deleted in same runOnce when minAge=0",
  );
  assert.equal(workflowIds.has(ageDeleteOld.id), false, "aged-out succeeded workflow must be deleted");
  assert.equal(workflowIds.has(ageKeepRecent.id), true, "recent succeeded workflow must remain");
  assert.equal(workflowIds.has(ageKeepMid.id), true, "mid keep-window workflow must remain");
  assert.equal(workflowIds.has(isolatedFailed.id), true, "isolated failed without takeover must remain");

  assert.equal(pipelineIds.has(activePipeline.id), true, "active pipeline must remain");
  assert.equal(pipelineIds.has(oldPipelineFailed.id), false, "superseded pipeline must be deleted");
  assert.equal(pipelineIds.has(pipeAgeDelete.id), false, "aged-out pipeline must be deleted");
  assert.equal(pipelineIds.has(pipeKeepA.id), true, "recent pipeline A must remain");
  assert.equal(pipelineIds.has(pipeKeepB.id), true, "recent pipeline B must remain");

  assert.equal(remainingActionLogs, 0, "follow-up action logs for deleted/orphan tasks must be gone");
  assert.equal(remainingNotificationLogs, 0, "follow-up notification logs for deleted/orphan tasks must be gone");
  assert.equal(remainingRuntimeEvents, 0, "runtime events for deleted workflow must be gone");
  assert.equal(remainingArchives, 0, "archives for deleted tasks must be gone");

  assert.ok(summary.supersededDeleted >= 1, "summary should count superseded workflow deletions");
  assert.ok(summary.zombieRunningCancelled >= 1, "summary should count zombie cancels");
  assert.ok(summary.generationJobDeleted >= 2, "summary should count pipeline supersede + age deletes");
  assert.ok(summary.novelWorkflowDeleted >= 2, "summary should count workflow supersede + age deletes");

  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true,
    summary,
    remainingWorkflowCount: remainingWorkflow.length,
    remainingPipelineCount: remainingPipeline.length,
  }), "utf8");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

test("TaskRetentionService.runOnce deletes supersede/age/orphan rows on real sqlite", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-novel-task-retention-"));
  try {
    const databaseUrl = setupTempSqliteDatabase(tempDir);
    const scriptPath = writeChildScript(tempDir);
    const resultPath = path.join(tempDir, "result.json");
    const result = childProcess.spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TASK_RETENTION_RESULT_PATH: resultPath,
        TASK_RETENTION_KEEP_PER_NOVEL: "2",
        TASK_RETENTION_SUCCEEDED_DAYS: "1",
        TASK_RETENTION_FAILED_DAYS: "2",
        TASK_RETENTION_SUPERSEDED_MIN_AGE_MS: "0",
        AUTO_DIRECTOR_STALE_RUNNING_TASK_MS: String(60 * 60 * 1000),
      },
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error(
        `taskRetention runOnce child failed (status=${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    }

    assert.equal(fs.existsSync(resultPath), true, "child must write result.json");
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(payload.ok, true);
    assert.ok(payload.remainingWorkflowCount >= 4);
    assert.ok(payload.remainingPipelineCount >= 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
