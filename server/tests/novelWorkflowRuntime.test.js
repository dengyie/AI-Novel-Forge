const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NovelWorkflowRuntimeService,
} = require("../dist/services/novel/workflow/NovelWorkflowRuntimeService.js");
const {
  NovelWorkflowService,
} = require("../dist/services/novel/workflow/NovelWorkflowService.js");
const {
  NovelWorkflowApplicationService,
} = require("../dist/services/novel/workflow/NovelWorkflowApplicationService.js");
const {
  isStaleAutoDirectorRunningTask,
  isStaleAutoDirectorRunningTaskBroad,
} = require("../dist/services/novel/workflow/recovery/index.js");
const {
  AutoDirectorFollowUpNotificationService,
} = require("../dist/services/task/autoDirectorFollowUps/AutoDirectorFollowUpNotificationService.js");
const { prisma } = require("../dist/db/prisma.js");

// 与 autoDirectorFollowUpNotificationService.test.js 相同的 workflow 行形状，
// 让 resume 流程触发的通知事件能走通真实 handleTaskTransition。
function buildWorkflowRow(overrides = {}) {
  return {
    id: "task-running",
    novelId: "novel_1",
    lane: "auto_director",
    title: "AI 自动导演",
    status: "waiting_approval",
    progress: 0.7,
    currentStage: "章节执行",
    currentItemKey: "chapter_execution",
    currentItemLabel: "等待继续自动执行",
    checkpointType: "chapter_batch_ready",
    checkpointSummary: "前 10 章已准备完成。",
    seedPayloadJson: null,
    pendingManualRecovery: false,
    lastError: null,
    updatedAt: new Date("2026-04-22T10:00:00.000Z"),
    novel: {
      title: "《雾港巡夜人》",
    },
    ...overrides,
  };
}

test("stale auto-director policy uses the latest heartbeat or persisted task activity", () => {
  const now = new Date("2026-05-04T00:00:00.000Z");
  const row = buildWorkflowRow({
    status: "running",
    currentItemKey: "beat_sheet",
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    heartbeatAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-03T23:59:00.000Z"),
  });

  assert.equal(isStaleAutoDirectorRunningTask(row, now), false);
  assert.equal(isStaleAutoDirectorRunningTaskBroad(row, now), false);
});

test("workflow cancel mutation reads raw task facts without entering healing", async () => {
  let row = buildWorkflowRow({
    status: "running",
    cancelRequestedAt: null,
    attemptCount: 1,
  });
  let rawReads = 0;
  const workflow = {
    getTaskById: async () => {
      throw new Error("cancel mutation must not invoke healing-aware lookup");
    },
    getTaskByIdWithoutHealing: async () => {
      rawReads += 1;
      return row;
    },
    updateTaskManyWithRetry: async ({ data }) => {
      row = {
        ...row,
        ...data,
        updatedAt: new Date(row.updatedAt.getTime() + 1),
      };
      return { count: 1 };
    },
    notifyAutoDirectorTaskTransition: async () => {},
  };
  const service = new NovelWorkflowApplicationService(workflow);

  const cancelled = await service.cancelTask(row.id);

  assert.equal(rawReads, 2, "cancel reads the raw snapshot before CAS and the committed row after CAS");
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelRequestedAt instanceof Date);
});

test("workflow cancel CAS does not overwrite a task that completed after lookup", async () => {
  const observed = buildWorkflowRow({
    status: "running",
    cancelRequestedAt: null,
    attemptCount: 1,
  });
  const completed = {
    ...observed,
    status: "succeeded",
    updatedAt: new Date(observed.updatedAt.getTime() + 1),
  };
  let reads = 0;
  const workflow = {
    getTaskByIdWithoutHealing: async () => {
      reads += 1;
      return reads === 1 ? observed : completed;
    },
    updateTaskManyWithRetry: async () => ({ count: 0 }),
    notifyAutoDirectorTaskTransition: async () => {
      throw new Error("CAS miss must not notify cancellation");
    },
  };
  const service = new NovelWorkflowApplicationService(workflow);

  await assert.rejects(
    () => service.cancelTask(observed.id),
    (error) => error?.statusCode === 409,
  );
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.cancelRequestedAt, null);
});

test("workflow retry claim reads raw task facts without entering healing", async () => {
  const row = buildWorkflowRow({
    status: "failed",
    attemptCount: 2,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    checkpointType: null,
  });
  const originals = {
    updateMany: prisma.novelWorkflowTask.updateMany,
    findUnique: prisma.novelWorkflowTask.findUnique,
  };
  let rawReads = 0;
  const workflow = {
    getTaskById: async () => {
      throw new Error("retry mutation must not invoke healing-aware lookup");
    },
    getTaskByIdWithoutHealing: async () => {
      rawReads += 1;
      return row;
    },
    notifyAutoDirectorTaskTransition: async () => {},
  };
  prisma.novelWorkflowTask.updateMany = async () => ({ count: 1 });
  prisma.novelWorkflowTask.findUnique = async () => ({
    ...row,
    status: "queued",
    attemptCount: 3,
    novel: { title: "测试小说" },
  });

  try {
    const service = new NovelWorkflowApplicationService(workflow);
    const claimed = await service.retryTask(row.id);

    assert.equal(rawReads, 1);
    assert.equal(claimed.status, "queued");
    assert.equal(claimed.attemptCount, 3);
  } finally {
    prisma.novelWorkflowTask.updateMany = originals.updateMany;
    prisma.novelWorkflowTask.findUnique = originals.findUnique;
  }
});

test("workflow retry claims an explicitly cancelled task by its cancellation snapshot", async () => {
  const cancelledAt = new Date("2026-05-04T00:00:01.000Z");
  const row = buildWorkflowRow({
    status: "cancelled",
    attemptCount: 2,
    pendingManualRecovery: false,
    cancelRequestedAt: cancelledAt,
    checkpointType: null,
  });
  const originals = {
    updateMany: prisma.novelWorkflowTask.updateMany,
    findUnique: prisma.novelWorkflowTask.findUnique,
  };
  let claimArgs = null;
  const workflow = {
    getTaskByIdWithoutHealing: async () => row,
    notifyAutoDirectorTaskTransition: async () => {},
  };
  prisma.novelWorkflowTask.updateMany = async (args) => {
    claimArgs = args;
    return { count: 1 };
  };
  prisma.novelWorkflowTask.findUnique = async () => ({
    ...row,
    status: "queued",
    attemptCount: 3,
    cancelRequestedAt: null,
    novel: { title: "测试小说" },
  });

  try {
    const service = new NovelWorkflowApplicationService(workflow);
    const claimed = await service.retryTask(row.id);

    assert.equal(claimArgs.where.status, "cancelled");
    assert.equal(claimArgs.where.cancelRequestedAt, cancelledAt);
    assert.equal(claimArgs.where.updatedAt, row.updatedAt);
    assert.equal(claimed.status, "queued");
    assert.equal(claimed.attemptCount, 3);
    assert.equal(claimed.cancelRequestedAt, null);
  } finally {
    prisma.novelWorkflowTask.updateMany = originals.updateMany;
    prisma.novelWorkflowTask.findUnique = originals.findUnique;
  }
});

test("workflow model override reads raw task facts without entering healing", async () => {
  const row = buildWorkflowRow({
    seedPayloadJson: JSON.stringify({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      temperature: 0.7,
    }),
  });
  let rawReads = 0;
  let updateData = null;
  const workflow = {
    getTaskById: async () => {
      throw new Error("model override mutation must not invoke healing-aware lookup");
    },
    getTaskByIdWithoutHealing: async () => {
      rawReads += 1;
      return row;
    },
    updateTaskWithRetry: async ({ data }) => {
      updateData = data;
      return { ...row, ...data };
    },
  };
  const service = new NovelWorkflowApplicationService(workflow);

  await service.applyAutoDirectorLlmOverride(row.id, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.5,
  });

  assert.equal(rawReads, 1);
  const seedPayload = JSON.parse(updateData.seedPayloadJson);
  assert.equal(seedPayload.model, "deepseek-v4-flash");
  assert.equal(seedPayload.temperature, 0.5);
});

test("resumePendingAutoDirectorTasks requeues interrupted running tasks before continuing", async () => {
  const calls = [];
  const runtimeService = new NovelWorkflowRuntimeService(
    {
      async listRecoverableAutoDirectorTasks() {
        return [{ id: "task-running", status: "running" }];
      },
      async requeueTaskForRecovery(taskId, message) {
        calls.push(["requeue", taskId, message]);
      },
      async markTaskFailed(taskId, message) {
        calls.push(["failed", taskId, message]);
      },
    },
    {
      async continueTask(taskId) {
        calls.push(["continue", taskId]);
      },
    },
  );

  await runtimeService.resumePendingAutoDirectorTasks();

  assert.deepEqual(calls, [
    ["requeue", "task-running", "自动导演任务因服务重启中断，正在尝试恢复。"],
    ["continue", "task-running"],
  ]);
});

test("resumePendingAutoDirectorTasks continues queued tasks without marking them for manual recovery", async () => {
  const calls = [];
  const runtimeService = new NovelWorkflowRuntimeService(
    {
      async listRecoverableAutoDirectorTasks() {
        return [{ id: "task-queued", status: "queued" }];
      },
      async requeueTaskForRecovery(taskId, message) {
        calls.push(["requeue", taskId, message]);
      },
      async markTaskFailed(taskId, message) {
        calls.push(["failed", taskId, message]);
      },
    },
    {
      async continueTask(taskId) {
        calls.push(["continue", taskId]);
      },
    },
  );

  await runtimeService.resumePendingAutoDirectorTasks();

  assert.deepEqual(calls, [
    ["continue", "task-queued"],
  ]);
});

test("resumePendingAutoDirectorTasks marks failed when recovery throws", async () => {
  const calls = [];
  const runtimeService = new NovelWorkflowRuntimeService(
    {
      async listRecoverableAutoDirectorTasks() {
        return [{ id: "task-queued", status: "queued" }];
      },
      async requeueTaskForRecovery(taskId, message) {
        calls.push(["requeue", taskId, message]);
      },
      async restoreTaskToCheckpoint(taskId) {
        calls.push(["restore", taskId]);
      },
      async markTaskFailed(taskId, message) {
        calls.push(["failed", taskId, message]);
      },
    },
    {
      async continueTask() {
        throw new Error("缺少恢复上下文");
      },
    },
  );

  await runtimeService.resumePendingAutoDirectorTasks();

  assert.deepEqual(calls, [
    ["failed", "task-queued", "服务重启后恢复失败：缺少恢复上下文"],
  ]);
});

test("resumePendingAutoDirectorTasks restores checkpoint instead of failing when recovery is no longer needed", async () => {
  const calls = [];
  const runtimeService = new NovelWorkflowRuntimeService(
    {
      async listRecoverableAutoDirectorTasks() {
        return [{ id: "task-chapter_range", status: "queued" }];
      },
      async requeueTaskForRecovery(taskId, message) {
        calls.push(["requeue", taskId, message]);
      },
      async restoreTaskToCheckpoint(taskId) {
        calls.push(["restore", taskId]);
      },
      async markTaskFailed(taskId, message) {
        calls.push(["failed", taskId, message]);
      },
    },
    {
      async continueTask() {
        const error = new Error("当前导演产物已经完整，无需继续自动导演。");
        error.code = "director_recovery_not_needed";
        throw error;
      },
    },
  );

  await runtimeService.resumePendingAutoDirectorTasks();

  assert.deepEqual(calls, [
    ["restore", "task-chapter_range"],
  ]);
});

test("markPendingAutoDirectorTasksForManualRecovery only marks tasks without continuing them", async () => {
  const calls = [];
  const runtimeService = new NovelWorkflowRuntimeService(
    {
      async listRecoverableAutoDirectorTasks() {
        return [
          { id: "task-queued", status: "queued" },
          { id: "task-running", status: "running" },
        ];
      },
      async requeueTaskForRecovery(taskId, message) {
        calls.push(["requeue", taskId, message]);
      },
    },
    {
      async continueTask(taskId) {
        calls.push(["continue", taskId]);
      },
    },
  );

  await runtimeService.markPendingAutoDirectorTasksForManualRecovery();

  assert.deepEqual(calls, [
    ["requeue", "task-queued", "服务重启后任务已暂停，等待手动恢复。"],
    ["requeue", "task-running", "服务重启后任务已暂停，等待手动恢复。"],
  ]);
});

test("markPendingAutoDirectorTasksForManualRecovery marks stale running tasks as failed when configured", async () => {
  const calls = [];
  const runtimeService = new NovelWorkflowRuntimeService(
    {
      async listRecoverableAutoDirectorTasks() {
        return [
          { id: "task-stale", status: "running", stale: true },
          { id: "task-fresh", status: "running" },
        ];
      },
      async requeueTaskForRecovery(taskId, message) {
        calls.push(["requeue", taskId, message]);
      },
      async markTaskFailed(taskId, message) {
        calls.push(["failed", taskId, message]);
      },
    },
    {
      async continueTask(taskId) {
        calls.push(["continue", taskId]);
      },
    },
  );

  await runtimeService.markPendingAutoDirectorTasksForManualRecovery({
    staleRunningAsFailed: true,
  });

  assert.deepEqual(calls, [
    ["failed", "task-stale", "自动导演任务长时间没有心跳，可能已因服务重启或内存不足中断。请检查后继续或重试。"],
    ["requeue", "task-fresh", "服务重启后任务已暂停，等待手动恢复。"],
  ]);
});

test("stale running auto director healing does not recurse through markTaskFailed", async () => {
  const originals = {
    archiveFindUnique: prisma.taskCenterArchive.findUnique,
    taskFindUnique: prisma.novelWorkflowTask.findUnique,
    taskUpdateMany: prisma.novelWorkflowTask.updateMany,
  };
  const updates = [];
  let staleRow = {
    id: "task-stale",
    novelId: "novel-1",
    lane: "auto_director",
    status: "running",
    progress: 0.4,
    currentStage: "结构化大纲",
    currentItemKey: "chapter_detail_bundle",
    currentItemLabel: "生成章节细纲",
    checkpointType: null,
    checkpointSummary: null,
    resumeTargetJson: null,
    seedPayloadJson: null,
    milestonesJson: null,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    heartbeatAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
  };

  prisma.taskCenterArchive.findUnique = async () => null;
  prisma.novelWorkflowTask.findUnique = async () => staleRow;
  prisma.novelWorkflowTask.updateMany = async ({ data }) => {
    updates.push(data);
    staleRow = {
      ...staleRow,
      ...data,
      updatedAt: new Date("2026-05-04T00:00:00.000Z"),
    };
    return { count: 1 };
  };

  try {
    const service = new NovelWorkflowService();
    service.markTaskFailed = async () => {
      throw new Error("healStaleAutoDirectorRunningTask must not call markTaskFailed");
    };
    service.notifyAutoDirectorTaskTransition = async () => {};

    const changed = await service.healStaleAutoDirectorRunningTask("task-stale", staleRow);

    assert.equal(changed, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, "failed");
    assert.equal(updates[0].lastError, "自动导演任务长时间没有心跳，可能已因服务重启或内存不足中断。请检查后继续或重试。");
  } finally {
    prisma.taskCenterArchive.findUnique = originals.archiveFindUnique;
    prisma.novelWorkflowTask.findUnique = originals.taskFindUnique;
    prisma.novelWorkflowTask.updateMany = originals.taskUpdateMany;
  }
});

test("startup recovery initialization auto-resumes interrupted tasks (including auto director)", async () => {
  const calls = [];
  const { RecoveryTaskService } = require("../dist/services/task/RecoveryTaskService.js");
  const recoveryService = new RecoveryTaskService(
    undefined,
    undefined,
    undefined,
    undefined,
    {
      async resumePendingBookAnalyses() {
        calls.push(["resume-book"]);
      },
      async resumePendingImageTasks() {
        calls.push(["resume-image"]);
      },
      async resumePendingAutoDirectorTasks() {
        calls.push(["resume-auto-director"]);
      },
      async resumePendingPipelineJobs() {
        calls.push(["resume-pipeline"]);
      },
      async resumePendingStyleTasks() {
        calls.push(["resume-style"]);
      },
      async resumePendingAudiobookTasks() {
        calls.push(["resume-audiobook"]);
      },
    },
  );

  await recoveryService.initializePendingRecoveries();

  assert.deepEqual(calls, [
    ["resume-book"],
    ["resume-image"],
    ["resume-auto-director"],
    ["resume-pipeline"],
    ["resume-style"],
    ["resume-audiobook"],
  ]);
});

// 回归：产线事故（readAt 缺列 → P2022）曾让通知写入一路抛到
// resumePendingAutoDirectorTasks 的 catch → markTaskFailed 整本书 failed。
// 续跑过程触发的通知副作用命中可容忍的 schema 漂移时必须被吞掉并打 warn，
// 任务继续推进，绝不被标 failed。
test("resumePendingAutoDirectorTasks does not fail the task when a notification write throws P2022", async () => {
  const originals = {
    notificationLogCreate: prisma.autoDirectorFollowUpNotificationLog.create,
    appSettingFindMany: prisma.appSetting.findMany,
    fetch: global.fetch,
    warn: console.warn,
  };
  const previousEnv = {
    dingtalkWebhook: process.env.AUTO_DIRECTOR_DINGTALK_WEBHOOK_URL,
    wecomWebhook: process.env.AUTO_DIRECTOR_WECOM_WEBHOOK_URL,
    appBaseUrl: process.env.APP_BASE_URL,
  };
  const calls = [];
  const warnMessages = [];

  // 复现产线事故：autoDirectorFollowUpNotificationLog 由 db push 建表、readAt 后加
  // schema 时产库未再 push → create 抛 "column `readAt` does not exist"（P2022）。
  prisma.autoDirectorFollowUpNotificationLog.create = async () => {
    throw Object.assign(new Error("PrismaClientKnownRequestError: \nInvalid `prisma.autoDirectorFollowUpNotificationLog.create()` invocation:\n\n  Column not found in the database.\n\n  The column `readAt` does not exist in the current database."), {
      code: "P2022",
    });
  };
  prisma.appSetting.findMany = async () => [];
  global.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
  console.warn = (message) => {
    warnMessages.push(String(message));
  };

  // 不配置外部渠道 → dingtalk/wecom 跳过，P2022 命中站内红点 inapp 写入路径。
  delete process.env.AUTO_DIRECTOR_DINGTALK_WEBHOOK_URL;
  delete process.env.AUTO_DIRECTOR_WECOM_WEBHOOK_URL;
  process.env.APP_BASE_URL = "https://writer.example.test";

  const notificationService = new AutoDirectorFollowUpNotificationService();
  const runtimeService = new NovelWorkflowRuntimeService(
    {
      async listRecoverableAutoDirectorTasks() {
        return [{ id: "task-running", status: "running" }];
      },
      async requeueTaskForRecovery(taskId, message) {
        calls.push(["requeue", taskId, message]);
      },
      async markTaskFailed(taskId, message) {
        calls.push(["failed", taskId, message]);
      },
    },
    {
      // 模拟真实续跑：continueTask 推进任务时触发站内红点通知副作用。
      async continueTask(taskId) {
        calls.push(["continue", taskId]);
        await notificationService.handleTaskTransition({
          before: buildWorkflowRow({
            status: "running",
            checkpointType: null,
            checkpointSummary: null,
            currentItemLabel: "正在执行章节",
            updatedAt: new Date("2026-04-22T09:55:00.000Z"),
          }),
          after: buildWorkflowRow({
            status: "failed",
            checkpointType: "chapter_batch_ready",
            checkpointSummary: "章节执行失败，需重试。",
            updatedAt: new Date("2026-04-22T10:00:00.000Z"),
          }),
        });
      },
    },
  );

  try {
    await runtimeService.resumePendingAutoDirectorTasks();

    // 任务必须走 requeue + continue 存活，绝无 failed 标记。
    assert.deepEqual(calls, [
      ["requeue", "task-running", "自动导演任务因服务重启中断，正在尝试恢复。"],
      ["continue", "task-running"],
    ]);
    // 吞掉 ≠ 无声：P2022 吞噬路径必须留 console.warn 可观测痕迹。
    assert.ok(
      warnMessages.some((message) => message.includes("[auto-director.notification]") && message.includes("in-app unread write swallowed")),
      "swallowed notification write should emit an observable console.warn",
    );
  } finally {
    prisma.autoDirectorFollowUpNotificationLog.create = originals.notificationLogCreate;
    prisma.appSetting.findMany = originals.appSettingFindMany;
    global.fetch = originals.fetch;
    console.warn = originals.warn;
    if (previousEnv.dingtalkWebhook == null) {
      delete process.env.AUTO_DIRECTOR_DINGTALK_WEBHOOK_URL;
    } else {
      process.env.AUTO_DIRECTOR_DINGTALK_WEBHOOK_URL = previousEnv.dingtalkWebhook;
    }
    if (previousEnv.wecomWebhook == null) {
      delete process.env.AUTO_DIRECTOR_WECOM_WEBHOOK_URL;
    } else {
      process.env.AUTO_DIRECTOR_WECOM_WEBHOOK_URL = previousEnv.wecomWebhook;
    }
    if (previousEnv.appBaseUrl == null) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = previousEnv.appBaseUrl;
    }
  }
});

// ---- P0-2 续跑防"取消复活"TOCTOU ----

const { NovelWorkflowHealingService } = require("../dist/services/novel/workflow/NovelWorkflowHealingService.js");

function buildStaleResumableAutoDirectorRow(overrides = {}) {
  return {
    id: "task-stale",
    novelId: "novel-1",
    lane: "auto_director",
    status: "running",
    currentItemKey: "beat_sheet",
    currentItemLabel: "正在生成第 1 卷节奏板",
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    heartbeatAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    seedPayloadJson: JSON.stringify({
      autoExecution: {
        enabled: true,
        autoRepair: true,
        circuitBreaker: { status: "closed" },
        remainingChapterCount: 5,
      },
    }),
    ...overrides,
  };
}

test("healStaleAutoDirectorRunningTask treats durable command acceptance as the only successful recovery projection", async () => {
  const staleRow = buildStaleResumableAutoDirectorRow();
  const enqueued = [];
  const updateManyCalls = [];
  const workflow = {
    getTaskByIdWithoutHealing: async () => staleRow,
    updateTaskManyWithRetry: async (args) => {
      updateManyCalls.push(args);
      return { count: 1 };
    },
  };
  const directorCommandService = {
    enqueueContinueCommand: async (taskId, opts, options) => {
      enqueued.push([taskId, opts, options]);
    },
  };
  const service = new NovelWorkflowHealingService(workflow, directorCommandService);

  const changed = await service.healStaleAutoDirectorRunningTask("task-stale", staleRow);

  assert.equal(changed, true);
  assert.deepEqual(enqueued, [
    [
      "task-stale",
      { continuationMode: "resume", forceResume: true },
      {
        expectedTaskState: {
          status: "running",
          updatedAt: staleRow.updatedAt,
          heartbeatAt: staleRow.heartbeatAt,
          currentItemKey: staleRow.currentItemKey,
        },
      },
    ],
  ]);
  assert.equal(updateManyCalls.length, 0, "healing must not compete with command acceptance projection");
});

test("healStaleAutoDirectorRunningTask preserves stale diagnostics when enqueue fails", async () => {
  const staleRow = buildStaleResumableAutoDirectorRow();
  const updateManyCalls = [];
  const workflow = {
    getTaskByIdWithoutHealing: async () => staleRow,
    updateTaskManyWithRetry: async (args) => {
      updateManyCalls.push(args);
      return { count: 1 };
    },
  };
  const directorCommandService = {
    enqueueContinueCommand: async () => {
      throw new Error("command create failed");
    },
  };
  const service = new NovelWorkflowHealingService(workflow, directorCommandService);

  const changed = await service.healStaleAutoDirectorRunningTask("task-stale", staleRow);

  assert.equal(changed, false);
  assert.equal(updateManyCalls.length, 0);
  assert.equal(staleRow.status, "running");
  assert.equal(staleRow.heartbeatAt.toISOString(), "2026-05-01T00:00:00.000Z");
});

test("healStaleAutoDirectorRunningTask does not overwrite cancellation on the non-resumable failure path", async () => {
  let currentRow = buildStaleResumableAutoDirectorRow({
    seedPayloadJson: null,
  });
  const updateManyCalls = [];
  const workflow = {
    getTaskByIdWithoutHealing: async () => currentRow,
    buildResumeTarget: () => ({ taskId: currentRow.id, stage: "auto_director" }),
    updateTaskManyWithRetry: async (args) => {
      updateManyCalls.push(args);
      currentRow = {
        ...currentRow,
        status: "cancelled",
        cancelRequestedAt: new Date("2026-05-04T00:00:01.000Z"),
        updatedAt: new Date("2026-05-04T00:00:01.000Z"),
      };
      return { count: 0 };
    },
    updateWorkflowTaskWithNotifications: async () => {
      throw new Error("non-resumable stale recovery must use cancellation-safe CAS");
    },
    notifyAutoDirectorTaskTransition: async () => {},
  };
  const service = new NovelWorkflowHealingService(workflow, null);

  const changed = await service.healStaleAutoDirectorRunningTask("task-stale", currentRow);

  assert.equal(changed, false);
  assert.equal(updateManyCalls.length, 1);
  assert.equal(currentRow.status, "cancelled");
  assert.ok(currentRow.cancelRequestedAt instanceof Date);
});

test("real workflow and command services close stale recovery without recursive healing and reuse one command", async () => {
  const originals = {
    transaction: prisma.$transaction,
    archiveFindUnique: prisma.taskCenterArchive.findUnique,
    taskFindUnique: prisma.novelWorkflowTask.findUnique,
    taskUpdateMany: prisma.novelWorkflowTask.updateMany,
    commandFindMany: prisma.directorRunCommand.findMany,
    commandFindFirst: prisma.directorRunCommand.findFirst,
    commandCreate: prisma.directorRunCommand.create,
  };
  const staleRow = buildStaleResumableAutoDirectorRow({
    lastError: "后台执行中断",
    finishedAt: new Date("2026-05-01T00:01:00.000Z"),
  });
  const commands = [];
  let rawReadCount = 0;

  prisma.$transaction = async (callback) => callback(prisma);
  prisma.taskCenterArchive.findUnique = async () => null;
  prisma.novelWorkflowTask.findUnique = async ({ where }) => {
    rawReadCount += 1;
    return where.id === staleRow.id ? staleRow : null;
  };
  prisma.novelWorkflowTask.updateMany = async ({ where, data }) => {
    if (where.id !== staleRow.id) return { count: 0 };
    Object.assign(staleRow, data, { updatedAt: new Date(staleRow.updatedAt.getTime() + 1) });
    return { count: 1 };
  };
  prisma.directorRunCommand.findMany = async () => [];
  prisma.directorRunCommand.findFirst = async ({ where }) => commands.find((command) => (
    command.taskId === where.taskId
    && (typeof where.commandType === "string"
      ? command.commandType === where.commandType
      : where.commandType.in.includes(command.commandType))
    && (!where.status || (typeof where.status === "string"
      ? command.status === where.status
      : where.status.in.includes(command.status)))
  )) ?? null;
  prisma.directorRunCommand.create = async ({ data }) => {
    const duplicate = commands.find((command) => (
      command.taskId === data.taskId
      && command.commandType === data.commandType
      && command.idempotencyKey === data.idempotencyKey
    ));
    if (duplicate) {
      const error = new Error("unique constraint");
      error.code = "P2002";
      throw error;
    }
    const command = {
      id: `command-${commands.length + 1}`,
      status: "queued",
      runAfter: new Date(),
      attempt: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    commands.push(command);
    return command;
  };

  try {
    const service = new NovelWorkflowService();
    const [first, second] = await Promise.all([
      service.healStaleAutoDirectorRunningTask(staleRow.id, staleRow),
      service.healStaleAutoDirectorRunningTask(staleRow.id, staleRow),
    ]);

    assert.deepEqual([first, second], [true, true]);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].commandType, "continue");
    assert.equal(staleRow.status, "queued");
    assert.equal(staleRow.lastError, null);
    assert.equal(staleRow.finishedAt, null);
    assert.ok(rawReadCount <= 6, `raw lookup count must stay bounded, got ${rawReadCount}`);
  } finally {
    prisma.$transaction = originals.transaction;
    prisma.taskCenterArchive.findUnique = originals.archiveFindUnique;
    prisma.novelWorkflowTask.findUnique = originals.taskFindUnique;
    prisma.novelWorkflowTask.updateMany = originals.taskUpdateMany;
    prisma.directorRunCommand.findMany = originals.commandFindMany;
    prisma.directorRunCommand.findFirst = originals.commandFindFirst;
    prisma.directorRunCommand.create = originals.commandCreate;
  }
});
