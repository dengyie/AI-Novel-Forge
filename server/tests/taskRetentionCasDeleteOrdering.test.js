const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { TaskRetentionService } = require("../dist/services/task/TaskRetentionService.js");

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
    autoRetried: 0,
    autoRetryBudgetSkipped: 0,
  };
}

test("retention rechecks terminal status and deletes task before dependents/archive rows", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const events = [];
  const originals = { transaction: prisma.$transaction };
  prisma.$transaction = async (callback) => callback({
    novelWorkflowTask: {
      findMany: async ({ where }) => {
        events.push(["eligible", where]);
        return [{ id: "terminal-task" }];
      },
      deleteMany: async ({ where }) => {
        events.push(["workflow-delete", where]);
        return { count: 1 };
      },
    },
    directorRuntimeEvent: { deleteMany: async () => { events.push(["event-delete"]); return { count: 1 }; } },
    directorRuntimeExecution: { deleteMany: async () => { events.push(["execution-delete"]); return { count: 1 }; } },
    directorRuntimeCommand: { deleteMany: async () => { events.push(["command-delete"]); return { count: 1 }; } },
    directorRuntimeInstance: { deleteMany: async () => { events.push(["instance-delete"]); return { count: 1 }; } },
    autoDirectorFollowUpActionLog: { deleteMany: async () => { events.push(["action-delete"]); return { count: 1 }; } },
    autoDirectorFollowUpNotificationLog: { deleteMany: async () => { events.push(["notification-delete"]); return { count: 1 }; } },
    taskCenterArchive: { deleteMany: async () => { events.push(["archive-delete"]); return { count: 1 }; } },
  });

  try {
    const summary = makeSummary();
    await service.deleteWorkflowTasks(["terminal-task"], summary);
    assert.equal(summary.novelWorkflowDeleted, 1);
    assert.equal(summary.runtimeRowsDeleted, 6);
    assert.equal(summary.archiveRowsDeleted, 1);
    assert.deepEqual(events.map(([name]) => name), [
      "eligible",
      "workflow-delete",
      "event-delete",
      "execution-delete",
      "command-delete",
      "instance-delete",
      "action-delete",
      "notification-delete",
      "archive-delete",
    ]);
    assert.deepEqual(events[0][1].status.in.sort(), ["cancelled", "failed", "succeeded"]);
    assert.deepEqual(events[1][1].status.in.sort(), ["cancelled", "failed", "succeeded"]);
  } finally {
    prisma.$transaction = originals.transaction;
  }
});

test("retention CAS recheck skips rows that became active before deletion", { concurrency: false }, async () => {
  const service = new TaskRetentionService();
  const originals = { transaction: prisma.$transaction };
  let deleteCalled = false;
  prisma.$transaction = async (callback) => callback({
    novelWorkflowTask: {
      findMany: async () => [],
      deleteMany: async () => { deleteCalled = true; return { count: 1 }; },
    },
  });
  try {
    const summary = makeSummary();
    await service.deleteWorkflowTasks(["became-running"], summary);
    assert.equal(deleteCalled, false);
    assert.equal(summary.novelWorkflowDeleted, 0);
  } finally {
    prisma.$transaction = originals.transaction;
  }
});
