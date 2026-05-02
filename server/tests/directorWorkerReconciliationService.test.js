const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  DirectorWorkerReconciliationService,
} = require("../dist/services/novel/director/DirectorWorkerReconciliationService.js");

function createHarness(overrides = {}) {
  const originals = {
    taskFindMany: prisma.novelWorkflowTask.findMany,
    stepUpdateMany: prisma.directorStepRun.updateMany,
    commandFindFirst: prisma.directorRunCommand.findFirst,
    commandFindMany: prisma.directorRunCommand.findMany,
    runtimeCommandFindUnique: prisma.directorRuntimeCommand.findUnique,
  };
  const calls = {
    stepUpdates: [],
    requeuedTasks: [],
  };
  const commandService = {
    recoverStaleLeases: async () => overrides.staleLeaseCount ?? 0,
  };
  const workflowService = {
    requeueTaskForRecovery: async (taskId, reason) => {
      calls.requeuedTasks.push({ taskId, reason });
    },
  };

  prisma.novelWorkflowTask.findMany = async ({ where }) => {
    if (where.status && typeof where.status === "object" && Array.isArray(where.status.in)) {
      return overrides.terminalTasks ?? [];
    }
    if (where.status === "running") {
      return overrides.runningTasks ?? [];
    }
    return [];
  };
  prisma.directorStepRun.updateMany = async (input) => {
    calls.stepUpdates.push(input);
    return { count: input.where.taskId.in.length };
  };
  prisma.directorRunCommand.findFirst = async ({ where }) => {
    const taskId = where.taskId;
    const resolver = overrides.commandResolver ?? (() => null);
    return resolver(where, taskId);
  };
  prisma.directorRunCommand.findMany = async () => [];
  prisma.directorRuntimeCommand.findUnique = async () => ({ id: "runtime-command-existing" });

  return {
    service: new DirectorWorkerReconciliationService(commandService, workflowService),
    calls,
    restore() {
      prisma.novelWorkflowTask.findMany = originals.taskFindMany;
      prisma.directorStepRun.updateMany = originals.stepUpdateMany;
      prisma.directorRunCommand.findFirst = originals.commandFindFirst;
      prisma.directorRunCommand.findMany = originals.commandFindMany;
      prisma.directorRuntimeCommand.findUnique = originals.runtimeCommandFindUnique;
    },
  };
}

test("director worker reconciliation closes running steps for terminal tasks", async () => {
  const harness = createHarness({
    staleLeaseCount: 2,
    terminalTasks: [
      { id: "task-cancelled", status: "cancelled", lastError: null },
      { id: "task-succeeded", status: "succeeded", lastError: null },
    ],
    runningTasks: [],
  });
  try {
    const result = await harness.service.reconcile(new Date("2026-04-30T09:00:00.000Z"));

    assert.equal(result.staleLeaseCount, 2);
    assert.equal(result.closedStepCount, 2);
    assert.equal(result.requeuedDanglingTaskCount, 0);
    assert.equal(harness.calls.stepUpdates.length, 2);
    assert.equal(harness.calls.stepUpdates[0].data.status, "failed");
    assert.equal(harness.calls.stepUpdates[1].data.status, "succeeded");
  } finally {
    harness.restore();
  }
});

test("director worker reconciliation requeues running tasks with recoverable terminal commands", async () => {
  const harness = createHarness({
    terminalTasks: [],
    runningTasks: [
      { id: "task-stale" },
      { id: "task-active" },
      { id: "task-done" },
    ],
    commandResolver: (where, taskId) => {
      if (where.status?.in) {
        return taskId === "task-active" ? { id: "active-command" } : null;
      }
      if (taskId === "task-stale") {
        return { status: "stale", errorMessage: "lease expired" };
      }
      if (taskId === "task-done") {
        return { status: "succeeded", errorMessage: null };
      }
      return null;
    },
  });
  try {
    const result = await harness.service.reconcile(new Date("2026-04-30T09:00:00.000Z"));

    assert.equal(result.requeuedDanglingTaskCount, 1);
    assert.deepEqual(harness.calls.requeuedTasks, [
      { taskId: "task-stale", reason: "lease expired" },
    ]);
  } finally {
    harness.restore();
  }
});
