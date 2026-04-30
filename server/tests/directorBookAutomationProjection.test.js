const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  DirectorBookAutomationProjectionService,
} = require("../dist/services/novel/director/DirectorBookAutomationProjectionService.js");

function createHarness(overrides = {}) {
  const latestTask = {
    id: "task-1",
    title: "AI 自动导演",
    status: "running",
    progress: 40,
    currentStage: "structured_outline",
    currentItemKey: "chapter_list",
    currentItemLabel: "生成章节任务单",
    checkpointType: "chapter_batch_ready",
    checkpointSummary: "章节任务单准备中。",
    pendingManualRecovery: false,
    lastError: null,
    seedPayloadJson: JSON.stringify({
      runMode: "full_book_autopilot",
    }),
    updatedAt: new Date("2026-04-30T09:00:00.000Z"),
    ...overrides.latestTask,
  };
  const latestRun = {
    id: "run-1",
    taskId: "task-1",
    policyJson: JSON.stringify({ mode: "auto_safe_scope" }),
    updatedAt: new Date("2026-04-30T09:00:01.000Z"),
    ...overrides.latestRun,
  };
  const commands = overrides.commands ?? [
    {
      id: "command-1",
      taskId: "task-1",
      novelId: "novel-1",
      commandType: "continue",
      status: "running",
      errorMessage: null,
      createdAt: new Date("2026-04-30T08:59:00.000Z"),
      updatedAt: new Date("2026-04-30T09:00:02.000Z"),
      startedAt: new Date("2026-04-30T08:59:30.000Z"),
      finishedAt: null,
    },
  ];
  const events = overrides.events ?? [
    {
      id: "event-1",
      runId: "run-1",
      taskId: "task-1",
      novelId: "novel-1",
      type: "node_heartbeat",
      nodeKey: "structured_outline.chapter_list",
      artifactType: null,
      summary: "正在生成章节任务单。",
      affectedScope: "novel:novel-1",
      severity: "low",
      occurredAt: new Date("2026-04-30T09:00:03.000Z"),
    },
  ];
  const steps = overrides.steps ?? [
    {
      idempotencyKey: "task-1:structured_outline.chapter_list:novel:novel-1",
      runId: "run-1",
      taskId: "task-1",
      novelId: "novel-1",
      nodeKey: "structured_outline.chapter_list",
      label: "生成章节任务单",
      status: "running",
      error: null,
      startedAt: new Date("2026-04-30T08:59:00.000Z"),
      finishedAt: null,
      updatedAt: new Date("2026-04-30T09:00:02.000Z"),
    },
  ];
  const approvals = overrides.approvals ?? [
    {
      id: "approval-1",
      taskId: "task-1",
      approvalPointLabel: "章节执行继续",
      checkpointSummary: "AI 自动继续章节生成。",
      summary: "AI 自动确认章节执行继续。",
      stage: "chapter_execution",
      scopeLabel: "全书",
      createdAt: new Date("2026-04-30T08:58:00.000Z"),
    },
  ];
  const counts = {
    active: 5,
    stale: 1,
    protected: 2,
    repair: 1,
    ...overrides.counts,
  };
  const originals = {
    taskFindFirst: prisma.novelWorkflowTask.findFirst,
    runFindFirst: prisma.directorRun.findFirst,
    commandFindMany: prisma.directorRunCommand.findMany,
    eventFindMany: prisma.directorEvent.findMany,
    stepFindMany: prisma.directorStepRun.findMany,
    approvalFindMany: prisma.autoDirectorAutoApprovalRecord.findMany,
    artifactCount: prisma.directorArtifact.count,
  };

  prisma.novelWorkflowTask.findFirst = async ({ where }) => {
    assert.equal(where.novelId, "novel-1");
    assert.equal(where.lane, "auto_director");
    return latestTask;
  };
  prisma.directorRun.findFirst = async ({ where }) => {
    assert.equal(where.novelId, "novel-1");
    return latestRun;
  };
  prisma.directorRunCommand.findMany = async ({ where }) => {
    assert.deepEqual(where.OR, [
      { novelId: "novel-1" },
      { taskId: { in: ["task-1"] } },
    ]);
    return commands;
  };
  prisma.directorEvent.findMany = async () => events;
  prisma.directorStepRun.findMany = async () => steps;
  prisma.autoDirectorAutoApprovalRecord.findMany = async ({ where }) => {
    assert.equal(where.novelId, "novel-1");
    return approvals;
  };
  prisma.directorArtifact.count = async ({ where }) => {
    if (where.status === "active") {
      return counts.active;
    }
    if (where.status === "stale") {
      return counts.stale;
    }
    if (where.protectedUserContent === true) {
      return counts.protected;
    }
    if (where.artifactType === "repair_ticket") {
      return counts.repair;
    }
    return 0;
  };

  return {
    service: new DirectorBookAutomationProjectionService(async () => overrides.runtimeProjection ?? {
      runId: "run-1",
      novelId: "novel-1",
      status: "running",
      currentNodeKey: "structured_outline.chapter_list",
      currentLabel: "生成章节任务单",
      headline: "推进任务：生成章节任务单",
      detail: "最近进展：正在生成章节任务单。",
      lastEventSummary: "正在生成章节任务单。",
      requiresUserAction: false,
      blockedReason: null,
      nextActionLabel: "继续章节生成",
      progressSummary: "进展：3/8 个步骤完成，5 个产物记录。",
      policyMode: "auto_safe_scope",
      updatedAt: "2026-04-30T09:00:03.000Z",
      recentEvents: [],
    }),
    restore() {
      prisma.novelWorkflowTask.findFirst = originals.taskFindFirst;
      prisma.directorRun.findFirst = originals.runFindFirst;
      prisma.directorRunCommand.findMany = originals.commandFindMany;
      prisma.directorEvent.findMany = originals.eventFindMany;
      prisma.directorStepRun.findMany = originals.stepFindMany;
      prisma.autoDirectorAutoApprovalRecord.findMany = originals.approvalFindMany;
      prisma.directorArtifact.count = originals.artifactCount;
    },
  };
}

test("book automation projection aggregates task, command, event, approval and artifact state by novel", async () => {
  const harness = createHarness();
  try {
    const projection = await harness.service.getProjection("novel-1");

    assert.equal(projection.novelId, "novel-1");
    assert.equal(projection.latestTask.id, "task-1");
    assert.equal(projection.latestRunId, "run-1");
    assert.equal(projection.status, "running");
    assert.equal(projection.runMode, "full_book_autopilot");
    assert.equal(projection.policyMode, "auto_safe_scope");
    assert.equal(projection.headline, "推进任务：生成章节任务单");
    assert.equal(projection.activeCommandCount, 1);
    assert.equal(projection.pendingCommandCount, 0);
    assert.equal(projection.autoApprovalRecordCount, 1);
    assert.deepEqual(projection.artifactSummary, {
      activeCount: 5,
      staleCount: 1,
      protectedUserContentCount: 2,
      repairTicketCount: 1,
    });
    assert.equal(projection.timeline[0].id, "event:event-1");
    assert.ok(projection.timeline.some((item) => item.id === "command:command-1"));
    assert.ok(projection.timeline.some((item) => item.id === "approval:approval-1"));
  } finally {
    harness.restore();
  }
});

test("book automation projection treats manual recovery as a book-level user action", async () => {
  const harness = createHarness({
    latestTask: {
      status: "running",
      pendingManualRecovery: true,
      lastError: "后台执行中断，点击恢复后继续。",
    },
    runtimeProjection: {
      runId: "run-1",
      novelId: "novel-1",
      status: "running",
      headline: "推进任务：生成章节任务单",
      detail: "最近进展：正在生成章节任务单。",
      requiresUserAction: false,
      blockedReason: null,
      policyMode: "auto_safe_scope",
      updatedAt: "2026-04-30T09:00:03.000Z",
      recentEvents: [],
    },
  });
  try {
    const projection = await harness.service.getProjection("novel-1");

    assert.equal(projection.status, "waiting_recovery");
    assert.equal(projection.requiresUserAction, true);
    assert.equal(projection.blockedReason, "后台执行中断，点击恢复后继续。");
    assert.equal(projection.headline, "等待恢复自动导演");
  } finally {
    harness.restore();
  }
});
