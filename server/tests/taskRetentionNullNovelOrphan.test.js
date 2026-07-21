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
  const databasePath = path.join(tempDir, "task-retention-null-novel.db");
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
  const scriptPath = path.join(tempDir, "run-null-novel-retention.cjs");
  const script = `
const path = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs");

async function main() {
  const repoRoot = process.cwd();
  const resultPath = process.env.TASK_RETENTION_NULL_NOVEL_RESULT_PATH;
  if (!resultPath) {
    throw new Error("TASK_RETENTION_NULL_NOVEL_RESULT_PATH is required");
  }

  global.prisma = undefined;

  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const { TaskRetentionService } = require(path.join(
    repoRoot,
    "server",
    "dist",
    "services",
    "task",
    "TaskRetentionService.js",
  ));

  const now = new Date("2026-07-01T00:00:00.000Z");
  const hourMs = 60 * 60 * 1000;
  const ageHours = (hours) => new Date(now.getTime() - hours * hourMs);

  // Stale null-novel active workflow (historical SetNull / abandoned create-before-bind)
  const staleWaiting = await prisma.novelWorkflowTask.create({
    data: {
      novelId: null,
      lane: "auto_director",
      title: "stale-null-waiting",
      status: "waiting_approval",
      heartbeatAt: ageHours(48),
      updatedAt: ageHours(48),
    },
  });
  const runtime = await prisma.directorRuntimeInstance.create({
    data: {
      novelId: null,
      workflowTaskId: staleWaiting.id,
      status: "waiting_approval",
    },
  });
  await prisma.directorRuntimeEvent.create({
    data: {
      id: "evt-null-novel-stale",
      runtimeId: runtime.id,
      workflowTaskId: staleWaiting.id,
      novelId: null,
      type: "checkpoint.waiting",
      summary: "orphan waiting",
      occurredAt: ageHours(48),
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "novel_workflow",
      taskId: staleWaiting.id,
    },
  });

  // Fresh null-novel active workflow — still within create-before-bind window
  const freshNull = await prisma.novelWorkflowTask.create({
    data: {
      novelId: null,
      lane: "manual_create",
      title: "fresh-null-running",
      status: "running",
      heartbeatAt: ageHours(1),
      updatedAt: ageHours(1),
    },
  });

  // Stale + fresh null-novel agent runs
  const staleAgent = await prisma.agentRun.create({
    data: {
      novelId: null,
      sessionId: "sess-stale-null",
      goal: "stale orphan agent",
      entryAgent: "reviewer",
      status: "waiting_approval",
      updatedAt: ageHours(36),
    },
  });
  await prisma.agentApproval.create({
    data: {
      runId: staleAgent.id,
      approvalType: "tool",
      targetType: "chapter",
      targetId: "ch-x",
      diffSummary: "pending",
      status: "pending",
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "agent_run",
      taskId: staleAgent.id,
    },
  });

  const freshAgent = await prisma.agentRun.create({
    data: {
      novelId: null,
      sessionId: "sess-fresh-null",
      goal: "fresh agent",
      entryAgent: "reviewer",
      status: "running",
      updatedAt: ageHours(2),
    },
  });

  // Bound novel active task must never be swept by null-novel purge
  const novel = await prisma.novel.create({
    data: {
      title: "bound-active",
      description: "keep",
      outline: "fixture",
      estimatedChapterCount: 1,
    },
  });
  const boundWaiting = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novel.id,
      lane: "auto_director",
      title: "bound-waiting",
      status: "waiting_approval",
      heartbeatAt: ageHours(72),
      updatedAt: ageHours(72),
    },
  });

  const service = new TaskRetentionService();
  const summary = await service.runOnce(now);

  const remainingWorkflowIds = new Set(
    (await prisma.novelWorkflowTask.findMany({ select: { id: true } })).map((row) => row.id),
  );
  const remainingAgentIds = new Set(
    (await prisma.agentRun.findMany({ select: { id: true } })).map((row) => row.id),
  );

  assert.equal(remainingWorkflowIds.has(staleWaiting.id), false, "stale null-novel workflow must be hard-deleted");
  assert.equal(remainingWorkflowIds.has(freshNull.id), true, "fresh null-novel workflow must remain");
  assert.equal(remainingWorkflowIds.has(boundWaiting.id), true, "bound waiting_approval must remain");
  assert.equal(remainingAgentIds.has(staleAgent.id), false, "stale null-novel agent must be hard-deleted");
  assert.equal(remainingAgentIds.has(freshAgent.id), true, "fresh null-novel agent must remain");

  assert.equal(await prisma.directorRuntimeEvent.count({ where: { workflowTaskId: staleWaiting.id } }), 0);
  assert.equal(await prisma.taskCenterArchive.count({ where: { taskId: staleWaiting.id } }), 0);
  assert.equal(await prisma.taskCenterArchive.count({ where: { taskId: staleAgent.id } }), 0);
  assert.equal(await prisma.agentApproval.count({ where: { runId: staleAgent.id } }), 0);

  assert.ok(summary.nullNovelOrphansDeleted >= 1, "summary must count null-novel workflow deletes");
  assert.ok(summary.nullNovelAgentRunsDeleted >= 1, "summary must count null-novel agent deletes");

  fs.writeFileSync(
    resultPath,
    JSON.stringify({
      ok: true,
      summary,
      remainingWorkflowCount: remainingWorkflowIds.size,
      remainingAgentCount: remainingAgentIds.size,
    }),
    "utf8",
  );
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

test("TaskRetentionService.runOnce purges stale null-novel active orphans", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-novel-null-novel-retention-"));
  try {
    const databaseUrl = setupTempSqliteDatabase(tempDir);
    const scriptPath = writeChildScript(tempDir);
    const resultPath = path.join(tempDir, "result.json");
    const result = childProcess.spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TASK_RETENTION_NULL_NOVEL_RESULT_PATH: resultPath,
        TASK_RETENTION_NULL_NOVEL_STALE_HOURS: "24",
        TASK_RETENTION_KEEP_PER_NOVEL: "20",
        TASK_RETENTION_SUCCEEDED_DAYS: "7",
        TASK_RETENTION_FAILED_DAYS: "30",
        TASK_RETENTION_SUPERSEDED_MIN_AGE_MS: "0",
      },
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error(
        `null-novel retention child failed (status=${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    }

    assert.equal(fs.existsSync(resultPath), true, "child must write result.json");
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(payload.ok, true);
    assert.ok(payload.summary.nullNovelOrphansDeleted >= 1);
    assert.ok(payload.summary.nullNovelAgentRunsDeleted >= 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
