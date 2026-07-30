const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { TaskRetentionService } = require("../dist/services/task/TaskRetentionService.js");
const { taskRetentionConfig } = require("../dist/config/taskRetention.js");

// 任务中心 autopilot P1 回归：
// - P1a 自动归档：succeeded/cancelled 超 autoArchiveSucceededHours、failed 超
//   autoArchiveFailedDays 自动写入 TaskCenterArchive（只影响可见性，不删数据）。
// - P1b 孤儿 AgentRun：宿主小说/章节已删、或章节已终态而 run 仍 active 超窗口
//   → 自动 cancel + 归档（生产曾留 3 条跨 14 天的 running 幽灵）。
// 与 artifactCheckpointHygiene 同约定：stub prisma 方法，不碰真实库。

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeSummary() {
  return {
    novelWorkflowDeleted: 0,
    generationJobDeleted: 0,
    archiveRowsDeleted: 0,
    runtimeRowsDeleted: 0,
    supersededDeleted: 0,
    zombieRunningCancelled: 0,
    nullNovelOrphansDeleted: 0,
    nullNovelAgentRunsDeleted: 0,
    autoArchived: 0,
    orphanAgentRunsCancelled: 0,
    staleRunningProjected: 0,
    waitingApprovalFlagged: 0,
  };
}

// --- P1a auto-archive ---
// 注意：stub 共享 prisma 单例，文件内用例必须串行（concurrency: false）。

test("autoArchiveTerminalTasks archives aged terminal tasks, keeps fresh ones visible", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const now = new Date("2026-07-30T00:00:00.000Z");
  const archived = [];
  const originals = {
    workflowFind: prisma.novelWorkflowTask.findMany,
    agentFind: prisma.agentRun.findMany,
    upsert: prisma.taskCenterArchive.upsert,
  };

  const queriedStatuses = [];
  prisma.novelWorkflowTask.findMany = async (args) => {
    assert.ok(args.where.finishedAt.lt instanceof Date, "must filter by finishedAt < cutoff");
    assert.equal(args.where.finishedAt.not, null, "must exclude null finishedAt");
    queriedStatuses.push(args.where.status);
    // 模拟 SQL：succeeded/cancelled 各有 1 条超过窗口的陈旧任务；failed 没有超过 7d 的。
    return args.where.status === "failed" ? [] : [{ id: `wf-old-${args.where.status}` }];
  };
  prisma.agentRun.findMany = async (args) => (
    args.where.status === "succeeded" ? [{ id: "ar-old-ok" }] : []
  );
  prisma.taskCenterArchive.upsert = async (args) => {
    archived.push(args.create);
    return {};
  };

  try {
    const count = await service.autoArchiveTerminalTasks(now, taskRetentionConfig);
    assert.equal(count, 3);
    assert.deepEqual(
      archived.map((a) => `${a.taskKind}:${a.taskId}`).sort(),
      ["agent_run:ar-old-ok", "novel_workflow:wf-old-cancelled", "novel_workflow:wf-old-succeeded"],
    );
    // 窗口语义：succeeded/cancelled 用 24h、failed 用 7d —— 三种状态都被查询。
    assert.deepEqual([...queriedStatuses].sort(), ["cancelled", "failed", "succeeded"]);
  } finally {
    prisma.novelWorkflowTask.findMany = originals.workflowFind;
    prisma.agentRun.findMany = originals.agentFind;
    prisma.taskCenterArchive.upsert = originals.upsert;
  }
});

test("autoArchiveTerminalTasks honors disabled windows (0 = off)", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const now = new Date("2026-07-30T00:00:00.000Z");
  const originals = {
    workflowFind: prisma.novelWorkflowTask.findMany,
    agentFind: prisma.agentRun.findMany,
    upsert: prisma.taskCenterArchive.upsert,
  };
  let queried = false;
  prisma.novelWorkflowTask.findMany = async () => { queried = true; return [{ id: "x" }]; };
  prisma.agentRun.findMany = async () => [];
  prisma.taskCenterArchive.upsert = async () => ({});

  try {
    const cfg = { ...taskRetentionConfig, autoArchiveSucceededHours: 0, autoArchiveFailedDays: 0 };
    const count = await service.autoArchiveTerminalTasks(now, cfg);
    assert.equal(count, 0);
    assert.equal(queried, false, "disabled windows must not even query");
  } finally {
    prisma.novelWorkflowTask.findMany = originals.workflowFind;
    prisma.agentRun.findMany = originals.agentFind;
    prisma.taskCenterArchive.upsert = originals.upsert;
  }
});

// --- P2 status projection self-heal ---

test("projectStaleActiveWorkflowTasks: fake-running manual lane → failed+recoverable; auto_director untouched", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const now = new Date("2026-07-30T00:00:00.000Z");
  const originals = {
    find: prisma.novelWorkflowTask.findMany,
    update: prisma.novelWorkflowTask.updateMany,
  };
  const projectedIds = [];
  const findCalls = [];

  prisma.novelWorkflowTask.findMany = async (args) => {
    findCalls.push(args.where);
    if (args.where.status === "running") {
      // 校验查询护栏：不含 auto_director lane、不含已标 recovery、不含 cancel 请求
      assert.equal(args.where.lane.not, "auto_director");
      assert.equal(args.where.pendingManualRecovery, false);
      assert.equal(args.where.cancelRequestedAt, null);
      assert.ok(args.where.updatedAt.lt instanceof Date);
      return [{ id: "wf-manual-stuck" }];
    }
    return []; // waiting_approval 查询
  };
  prisma.novelWorkflowTask.updateMany = async (args) => {
    if (args.data.status === "failed") {
      projectedIds.push(...args.where.id.in);
      assert.equal(args.data.pendingManualRecovery, true);
      assert.ok(args.data.finishedAt instanceof Date);
      assert.match(args.data.lastError, /心跳/);
      // 条件 update 防竞态
      assert.equal(args.where.status, "running");
      return { count: args.where.id.in.length };
    }
    return { count: 0 };
  };

  try {
    const summary = makeSummary();
    await service.projectStaleActiveWorkflowTasks(now, taskRetentionConfig, summary);
    assert.equal(summary.staleRunningProjected, 1);
    assert.deepEqual(projectedIds, ["wf-manual-stuck"]);
  } finally {
    prisma.novelWorkflowTask.findMany = originals.find;
    prisma.novelWorkflowTask.updateMany = originals.update;
  }
});

test("projectStaleActiveWorkflowTasks: stale waiting_approval → pendingManualRecovery attention flag, status untouched", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const now = new Date("2026-07-30T00:00:00.000Z");
  const originals = {
    find: prisma.novelWorkflowTask.findMany,
    update: prisma.novelWorkflowTask.updateMany,
  };
  const flaggedIds = [];

  prisma.novelWorkflowTask.findMany = async (args) => {
    if (args.where.status === "waiting_approval") {
      assert.equal(args.where.pendingManualRecovery, false);
      assert.ok(args.where.updatedAt.lt instanceof Date);
      return [{ id: "wf-approval-old" }];
    }
    return [];
  };
  prisma.novelWorkflowTask.updateMany = async (args) => {
    // 只置 pendingManualRecovery，不动 status（审批语义保留）
    assert.deepEqual(Object.keys(args.data), ["pendingManualRecovery"]);
    flaggedIds.push(...args.where.id.in);
    assert.equal(args.where.status, "waiting_approval");
    return { count: args.where.id.in.length };
  };

  try {
    const summary = makeSummary();
    await service.projectStaleActiveWorkflowTasks(now, taskRetentionConfig, summary);
    assert.equal(summary.waitingApprovalFlagged, 1);
    assert.equal(summary.staleRunningProjected, 0);
    assert.deepEqual(flaggedIds, ["wf-approval-old"]);
  } finally {
    prisma.novelWorkflowTask.findMany = originals.find;
    prisma.novelWorkflowTask.updateMany = originals.update;
  }
});

test("projectStaleActiveWorkflowTasks: no stale rows → no writes", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const originals = {
    find: prisma.novelWorkflowTask.findMany,
    update: prisma.novelWorkflowTask.updateMany,
  };
  prisma.novelWorkflowTask.findMany = async () => [];
  let updateCalled = false;
  prisma.novelWorkflowTask.updateMany = async () => { updateCalled = true; return { count: 0 }; };

  try {
    const summary = makeSummary();
    await service.projectStaleActiveWorkflowTasks(new Date(), taskRetentionConfig, summary);
    assert.equal(summary.staleRunningProjected, 0);
    assert.equal(summary.waitingApprovalFlagged, 0);
    assert.equal(updateCalled, false);
  } finally {
    prisma.novelWorkflowTask.findMany = originals.find;
    prisma.novelWorkflowTask.updateMany = originals.update;
  }
});

// --- P1b orphan agent runs ---

test("reconcileOrphanAgentRuns cancels+archives runs with terminal/deleted hosts, spares writing hosts", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const now = new Date("2026-07-30T00:00:00.000Z");
  const stale = new Date(now.getTime() - 2 * HOUR);
  const originals = {
    agentFind: prisma.agentRun.findMany,
    novelFind: prisma.novel.findMany,
    chapterFind: prisma.chapter.findMany,
    approvalUpdate: prisma.agentApproval.updateMany,
    agentUpdate: prisma.agentRun.updateMany,
    upsert: prisma.taskCenterArchive.upsert,
  };
  const cancelled = [];
  const archivedIds = [];
  const approvalExpired = [];

  prisma.agentRun.findMany = async (args) => {
    assert.deepEqual([...args.where.status.in].sort(), ["queued", "running", "waiting_approval"]);
    return [
      { id: "run-terminal-chapter", novelId: "n1", chapterId: "c-completed" },
      { id: "run-deleted-chapter", novelId: "n1", chapterId: "c-gone" },
      { id: "run-deleted-novel", novelId: "n-gone", chapterId: null },
      { id: "run-writing-chapter", novelId: "n1", chapterId: "c-writing" },
    ];
  };
  prisma.novel.findMany = async () => [{ id: "n1" }]; // n-gone 不存在
  prisma.chapter.findMany = async () => [
    { id: "c-completed", chapterStatus: "completed" },
    { id: "c-writing", chapterStatus: "generating" },
    // c-gone 不存在
  ];
  prisma.agentApproval.updateMany = async (args) => {
    approvalExpired.push(...args.where.runId.in);
    return { count: args.where.runId.in.length };
  };
  prisma.agentRun.updateMany = async (args) => {
    cancelled.push(...args.where.id.in);
    assert.equal(args.data.status, "cancelled");
    assert.ok(args.data.finishedAt instanceof Date);
    return { count: args.where.id.in.length };
  };
  prisma.taskCenterArchive.upsert = async (args) => {
    archivedIds.push(args.create.taskId);
    return {};
  };

  try {
    const summary = makeSummary();
    await service.reconcileOrphanAgentRuns(now, taskRetentionConfig, summary);
    assert.equal(summary.orphanAgentRunsCancelled, 3);
    assert.deepEqual(
      [...cancelled].sort(),
      ["run-deleted-chapter", "run-deleted-novel", "run-terminal-chapter"],
      "terminal chapter / deleted chapter / deleted novel hosts must all be cancelled",
    );
    assert.ok(!cancelled.includes("run-writing-chapter"), "chapter still generating must be spared (lock hygiene owns it)");
    assert.deepEqual([...archivedIds].sort(), [...cancelled].sort(), "cancelled orphans must be archived immediately");
    assert.deepEqual([...approvalExpired].sort(), [...cancelled].sort(), "pending approvals must be expired");
  } finally {
    prisma.agentRun.findMany = originals.agentFind;
    prisma.novel.findMany = originals.novelFind;
    prisma.chapter.findMany = originals.chapterFind;
    prisma.agentApproval.updateMany = originals.approvalUpdate;
    prisma.agentRun.updateMany = originals.agentUpdate;
    prisma.taskCenterArchive.upsert = originals.upsert;
  }
});

test("reconcileOrphanAgentRuns no-ops when no stale active runs", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const now = new Date("2026-07-30T00:00:00.000Z");
  const originals = {
    agentFind: prisma.agentRun.findMany,
    novelFind: prisma.novel.findMany,
    chapterFind: prisma.chapter.findMany,
    agentUpdate: prisma.agentRun.updateMany,
  };
  prisma.agentRun.findMany = async () => [];
  let novelQueried = false;
  prisma.novel.findMany = async () => { novelQueried = true; return []; };
  let updateCalled = false;
  prisma.agentRun.updateMany = async () => { updateCalled = true; return { count: 0 }; };

  try {
    const summary = makeSummary();
    await service.reconcileOrphanAgentRuns(now, taskRetentionConfig, summary);
    assert.equal(summary.orphanAgentRunsCancelled, 0);
    assert.equal(novelQueried, false, "no candidates → no follow-up queries");
    assert.equal(updateCalled, false);
  } finally {
    prisma.agentRun.findMany = originals.agentFind;
    prisma.novel.findMany = originals.novelFind;
    prisma.chapter.findMany = originals.chapterFind;
    prisma.agentRun.updateMany = originals.agentUpdate;
  }
});
