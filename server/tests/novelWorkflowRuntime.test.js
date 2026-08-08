const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NovelWorkflowRuntimeService,
} = require("../dist/services/novel/workflow/NovelWorkflowRuntimeService.js");
const {
  NovelWorkflowService,
} = require("../dist/services/novel/workflow/NovelWorkflowService.js");
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
    taskUpdate: prisma.novelWorkflowTask.update,
  };
  const updates = [];
  const staleRow = {
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
  prisma.novelWorkflowTask.update = async ({ data }) => {
    updates.push(data);
    return {
      ...staleRow,
      ...data,
      novel: { title: "测试小说" },
      updatedAt: new Date("2026-05-04T00:00:00.000Z"),
    };
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
    prisma.novelWorkflowTask.update = originals.taskUpdate;
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
