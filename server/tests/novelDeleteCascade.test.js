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
  const databasePath = path.join(tempDir, "novel-delete-cascade.db");
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
  const scriptPath = path.join(tempDir, "run-novel-delete-cascade.cjs");
  const script = `
const path = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs");

async function main() {
  const repoRoot = process.cwd();
  const resultPath = process.env.NOVEL_DELETE_CASCADE_RESULT_PATH;
  if (!resultPath) {
    throw new Error("NOVEL_DELETE_CASCADE_RESULT_PATH is required");
  }

  global.prisma = undefined;

  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const { purgeTasksOwnedByNovel } = require(path.join(
    repoRoot,
    "server",
    "dist",
    "services",
    "novel",
    "novelDeleteCascade.js",
  ));
  const { NovelCoreCrudService } = require(path.join(
    repoRoot,
    "server",
    "dist",
    "services",
    "novel",
    "novelCoreCrudService.js",
  ));

  const now = new Date("2026-07-01T00:00:00.000Z");

  const novel = await prisma.novel.create({
    data: {
      title: "delete-cascade-fixture",
      description: "purge tasks on delete",
      outline: "fixture",
      estimatedChapterCount: 2,
    },
  });

  const keepNovel = await prisma.novel.create({
    data: {
      title: "keep-other-novel",
      description: "must not be purged",
      outline: "fixture",
      estimatedChapterCount: 1,
    },
  });

  const waitingTask = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novel.id,
      lane: "auto_director",
      title: "waiting-approval-ghost",
      status: "waiting_approval",
      heartbeatAt: now,
      updatedAt: now,
    },
  });
  const runningTask = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novel.id,
      lane: "manual_create",
      title: "running-workflow",
      status: "running",
      heartbeatAt: now,
      updatedAt: now,
    },
  });
  const succeededTask = await prisma.novelWorkflowTask.create({
    data: {
      novelId: novel.id,
      lane: "auto_director",
      title: "succeeded-workflow",
      status: "succeeded",
      finishedAt: now,
      updatedAt: now,
    },
  });
  const keepWorkflow = await prisma.novelWorkflowTask.create({
    data: {
      novelId: keepNovel.id,
      lane: "auto_director",
      title: "other-novel-workflow",
      status: "waiting_approval",
      heartbeatAt: now,
      updatedAt: now,
    },
  });

  const runtime = await prisma.directorRuntimeInstance.create({
    data: {
      novelId: novel.id,
      workflowTaskId: waitingTask.id,
      status: "waiting_approval",
    },
  });
  await prisma.directorRuntimeEvent.create({
    data: {
      id: "evt-delete-cascade-1",
      runtimeId: runtime.id,
      workflowTaskId: waitingTask.id,
      novelId: novel.id,
      type: "checkpoint.waiting",
      summary: "waiting for approval",
      occurredAt: now,
    },
  });
  await prisma.autoDirectorFollowUpActionLog.create({
    data: {
      taskId: waitingTask.id,
      actionCode: "retry",
      sourceChannel: "test",
      idempotencyKey: "delete-cascade-action-1",
      resultCode: "ok",
    },
  });
  await prisma.autoDirectorFollowUpNotificationLog.create({
    data: {
      eventId: "notif-delete-cascade-1",
      eventType: "auto_director.exception",
      taskId: waitingTask.id,
      channelType: "wecom",
      status: "delivered",
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "novel_workflow",
      taskId: waitingTask.id,
    },
  });

  const generationJob = await prisma.generationJob.create({
    data: {
      novelId: novel.id,
      startOrder: 1,
      endOrder: 2,
      status: "running",
      totalCount: 2,
      heartbeatAt: now,
      updatedAt: now,
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "novel_pipeline",
      taskId: generationJob.id,
    },
  });

  const audiobook = await prisma.audiobookTask.create({
    data: {
      novelId: novel.id,
      title: "audiobook-running",
      scopeMode: "all",
      narratorVoice: "default",
      narratorStyle: "neutral",
      status: "running",
      heartbeatAt: now,
      updatedAt: now,
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "novel_audiobook",
      taskId: audiobook.id,
    },
  });

  const imageTask = await prisma.imageGenerationTask.create({
    data: {
      novelId: novel.id,
      provider: "test",
      model: "test-model",
      prompt: "cover",
      status: "queued",
      updatedAt: now,
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "image_generation",
      taskId: imageTask.id,
    },
  });

  const agentRun = await prisma.agentRun.create({
    data: {
      novelId: novel.id,
      sessionId: "sess-delete-cascade",
      goal: "review chapter",
      entryAgent: "reviewer",
      status: "waiting_approval",
      updatedAt: now,
    },
  });
  await prisma.agentApproval.create({
    data: {
      runId: agentRun.id,
      approvalType: "tool",
      targetType: "chapter",
      targetId: "ch-1",
      diffSummary: "pending edit",
      status: "pending",
    },
  });
  await prisma.taskCenterArchive.create({
    data: {
      taskKind: "agent_run",
      taskId: agentRun.id,
    },
  });

  const keepAgent = await prisma.agentRun.create({
    data: {
      novelId: keepNovel.id,
      sessionId: "sess-keep",
      goal: "keep me",
      entryAgent: "reviewer",
      status: "running",
      updatedAt: now,
    },
  });

  await prisma.ragIndexJob.create({
    data: {
      jobType: "upsert",
      ownerType: "novel",
      ownerId: novel.id,
      status: "queued",
    },
  });
  await prisma.ragIndexJob.create({
    data: {
      jobType: "delete",
      ownerType: "novel",
      ownerId: novel.id,
      status: "queued",
    },
  });

  // Direct purge path
  const summary = await purgeTasksOwnedByNovel(novel.id);
  assert.ok(summary.workflowTasksDeleted >= 3, "all workflow tasks for novel must hard-delete");
  assert.ok(summary.workflowTasksCancelled >= 2, "active workflows must be cancelled first");
  assert.ok(summary.agentRunsDeleted >= 1, "agent runs for novel must hard-delete");
  assert.ok(summary.generationJobsCancelled >= 1, "running generation job must be cancelled");
  assert.ok(summary.ragIndexJobsCancelled >= 1, "queued upsert rag jobs must cancel");

  assert.equal(await prisma.novelWorkflowTask.count({ where: { novelId: novel.id } }), 0);
  assert.equal(await prisma.agentRun.count({ where: { novelId: novel.id } }), 0);
  assert.equal(await prisma.directorRuntimeEvent.count({ where: { novelId: novel.id } }), 0);
  assert.equal(await prisma.directorRuntimeInstance.count({ where: { novelId: novel.id } }), 0);
  assert.equal(await prisma.autoDirectorFollowUpActionLog.count({ where: { taskId: waitingTask.id } }), 0);
  assert.equal(await prisma.taskCenterArchive.count({ where: { taskId: waitingTask.id } }), 0);
  assert.equal(await prisma.taskCenterArchive.count({ where: { taskId: generationJob.id } }), 0);
  assert.equal(await prisma.taskCenterArchive.count({ where: { taskId: audiobook.id } }), 0);
  assert.equal(await prisma.taskCenterArchive.count({ where: { taskId: imageTask.id } }), 0);
  assert.equal(await prisma.taskCenterArchive.count({ where: { taskId: agentRun.id } }), 0);

  const cancelledUpsert = await prisma.ragIndexJob.findFirst({
    where: { ownerId: novel.id, jobType: "upsert" },
  });
  assert.equal(cancelledUpsert?.status, "cancelled");
  const keepDeleteJob = await prisma.ragIndexJob.findFirst({
    where: { ownerId: novel.id, jobType: "delete" },
  });
  assert.equal(keepDeleteJob?.status, "queued", "delete rag jobs must remain for index cleanup");

  // Generation/audiobook/image rows still exist until novel FK cascade; they should be cancelled.
  const remainingJob = await prisma.generationJob.findUnique({ where: { id: generationJob.id } });
  assert.equal(remainingJob?.status, "cancelled");
  const remainingAudiobook = await prisma.audiobookTask.findUnique({ where: { id: audiobook.id } });
  assert.equal(remainingAudiobook?.status, "cancelled");
  const remainingImage = await prisma.imageGenerationTask.findUnique({ where: { id: imageTask.id } });
  assert.equal(remainingImage?.status, "cancelled");

  // Other novel must be untouched
  assert.equal(await prisma.novelWorkflowTask.count({ where: { id: keepWorkflow.id } }), 1);
  assert.equal(await prisma.agentRun.count({ where: { id: keepAgent.id } }), 1);

  // Full deleteNovel path: recreate orphans bound to a second victim novel
  const victim = await prisma.novel.create({
    data: {
      title: "deleteNovel-victim",
      description: "service path",
      outline: "fixture",
      estimatedChapterCount: 1,
    },
  });
  const victimTask = await prisma.novelWorkflowTask.create({
    data: {
      novelId: victim.id,
      lane: "auto_director",
      title: "victim-waiting",
      status: "waiting_approval",
      heartbeatAt: now,
      updatedAt: now,
    },
  });
  const victimAgent = await prisma.agentRun.create({
    data: {
      novelId: victim.id,
      sessionId: "sess-victim",
      goal: "victim agent",
      entryAgent: "reviewer",
      status: "waiting_approval",
      updatedAt: now,
    },
  });
  const victimRuntime = await prisma.directorRuntimeInstance.create({
    data: {
      novelId: victim.id,
      workflowTaskId: victimTask.id,
      status: "waiting_approval",
    },
  });
  await prisma.directorRuntimeEvent.create({
    data: {
      id: "evt-delete-novel-victim",
      runtimeId: victimRuntime.id,
      workflowTaskId: victimTask.id,
      novelId: victim.id,
      type: "checkpoint.waiting",
      summary: "victim waiting",
      occurredAt: now,
    },
  });

  const service = new NovelCoreCrudService();
  await service.deleteNovel(victim.id);

  assert.equal(await prisma.novel.count({ where: { id: victim.id } }), 0);
  assert.equal(await prisma.novelWorkflowTask.count({ where: { id: victimTask.id } }), 0);
  assert.equal(await prisma.agentRun.count({ where: { id: victimAgent.id } }), 0);
  assert.equal(await prisma.directorRuntimeInstance.count({ where: { novelId: victim.id } }), 0);
  assert.equal(await prisma.directorRuntimeEvent.count({ where: { novelId: victim.id } }), 0);

  // Cascade FK: deleting novel without pre-purge should also drop bound workflow/agent
  // (schema onDelete: Cascade). Runtime rows without FK still need app purge — already covered.
  const cascadeNovel = await prisma.novel.create({
    data: {
      title: "cascade-only",
      description: "fk cascade",
      outline: "fixture",
      estimatedChapterCount: 1,
    },
  });
  const cascadeTask = await prisma.novelWorkflowTask.create({
    data: {
      novelId: cascadeNovel.id,
      lane: "auto_director",
      title: "cascade-task",
      status: "waiting_approval",
      updatedAt: now,
    },
  });
  await prisma.novel.delete({ where: { id: cascadeNovel.id } });
  assert.equal(
    await prisma.novelWorkflowTask.count({ where: { id: cascadeTask.id } }),
    0,
    "schema Cascade must hard-delete bound NovelWorkflowTask",
  );

  fs.writeFileSync(
    resultPath,
    JSON.stringify({
      ok: true,
      summary,
      keptWorkflowId: keepWorkflow.id,
      keptAgentId: keepAgent.id,
      remainingNovelCount: await prisma.novel.count(),
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

test("purgeTasksOwnedByNovel + deleteNovel remove task-center orphans on real sqlite", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-novel-delete-cascade-"));
  try {
    const databaseUrl = setupTempSqliteDatabase(tempDir);
    const scriptPath = writeChildScript(tempDir);
    const resultPath = path.join(tempDir, "result.json");
    const result = childProcess.spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NOVEL_DELETE_CASCADE_RESULT_PATH: resultPath,
      },
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error(
        `novelDeleteCascade child failed (status=${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    }

    assert.equal(fs.existsSync(resultPath), true, "child must write result.json");
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(payload.ok, true);
    assert.ok(payload.summary.workflowTasksDeleted >= 3);
    assert.ok(payload.summary.agentRunsDeleted >= 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
