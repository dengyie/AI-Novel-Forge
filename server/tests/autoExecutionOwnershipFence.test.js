const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AutoExecutionOwnershipFence,
} = require("../dist/services/novel/director/automation/domain/AutoExecutionOwnershipFence.js");
const {
  NovelWorkflowApplicationService,
} = require("../dist/services/novel/workflow/NovelWorkflowApplicationService.js");
const {
  NovelWorkflowStoreService,
} = require("../dist/services/novel/workflow/NovelWorkflowStoreService.js");
const { prisma } = require("../dist/db/prisma.js");

function task(overrides = {}) {
  return {
    id: "task-1",
    novelId: "novel-1",
    lane: "auto_director",
    status: "running",
    attemptCount: 3,
    ownershipVersion: 7,
    cancelRequestedAt: null,
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

function commandExecution(overrides = {}) {
  return {
    commandId: "command-1",
    leaseOwner: "worker-a:slot-1",
    leaseAttempt: 3,
    leaseMs: 120_000,
    ...overrides,
  };
}

test("non-ownership telemetry updates do not invalidate the active attempt", { concurrency: false }, async () => {
  let lookupCount = 0;
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getTaskByIdWithoutHealing: async () => {
        lookupCount += 1;
        return task({
          updatedAt: new Date(`2026-08-10T00:00:0${lookupCount}.000Z`),
        });
      },
    },
    novelService: {
      cancelPipelineJob: async () => undefined,
    },
  }, "task-1");

  const first = await fence.assertActive();
  const second = await fence.assertActive();

  assert.equal(first.attemptCount, 3);
  assert.equal(second.attemptCount, 3);
  assert.equal(first.ownershipVersion, 7);
  assert.equal(second.ownershipVersion, 7);
});

test("ownership lookup infrastructure errors are not converted into ownership loss", { concurrency: false }, async () => {
  const infrastructureError = new Error("database unavailable");
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getTaskByIdWithoutHealing: async () => {
        throw infrastructureError;
      },
    },
    novelService: {
      cancelPipelineJob: async () => undefined,
    },
  }, "task-1");

  await assert.rejects(() => fence.assertActive(), (error) => error === infrastructureError);
});

test("command ownership lookup infrastructure errors are not converted into ownership loss", { concurrency: false }, async () => {
  const infrastructureError = new Error("director command store unavailable");
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getDirectorCommandLeaseWithoutHealing: async () => {
        throw infrastructureError;
      },
      getTaskByIdWithoutHealing: async () => task(),
    },
    novelService: {
      cancelPipelineJob: async () => undefined,
    },
  }, "task-1", undefined, null, commandExecution());

  await assert.rejects(() => fence.assertActive(), (error) => error === infrastructureError);
});

test("an old fence cannot adopt a replacement worker before its first task ownership read", { concurrency: false }, async () => {
  let taskLookups = 0;
  let cancelCalls = 0;
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getDirectorCommandLeaseWithoutHealing: async () => ({
        id: "command-1",
        taskId: "task-1",
        status: "running",
        leaseOwner: "worker-b:slot-2",
        leaseExpiresAt: new Date("2099-08-11T00:00:00.000Z"),
        attempt: 4,
      }),
      getTaskByIdWithoutHealing: async () => {
        taskLookups += 1;
        return task({ attemptCount: 4, ownershipVersion: 8 });
      },
    },
    novelService: {
      cancelPipelineJob: async () => {
        cancelCalls += 1;
      },
    },
  }, "task-1", undefined, "job-old", commandExecution());

  await assert.rejects(
    () => fence.assertActive(),
    (error) => error?.code === "AUTO_EXECUTION_OWNERSHIP_LOST",
  );
  assert.equal(taskLookups, 0);
  assert.equal(cancelCalls, 0);
});

test("pipeline cancellation infrastructure errors are not swallowed when ownership is cancelled", { concurrency: false }, async () => {
  const infrastructureError = new Error("pipeline store unavailable");
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getTaskByIdWithoutHealing: async () => task({ status: "cancelled" }),
    },
    novelService: {
      cancelPipelineJob: async () => {
        throw infrastructureError;
      },
    },
  }, "task-1", undefined, "job-1");

  await assert.rejects(() => fence.assertActive(), (error) => error === infrastructureError);
});

test("workflow write CAS miss raises ownership loss before notification or stale projection", { concurrency: false }, async () => {
  const store = {
    getTaskByIdWithoutHealing: async () => task(),
    buildResumeTarget: () => ({ taskId: "task-1", stage: "chapter_execution" }),
    updateWorkflowTaskWithOwnership: async () => {
      const error = new Error("workflow ownership predicate did not match");
      error.code = "WORKFLOW_TASK_OWNERSHIP_LOST";
      throw error;
    },
  };
  const notifications = [];
  store.notifyAutoDirectorTaskTransition = async (input) => notifications.push(input);
  const service = new NovelWorkflowApplicationService(store);
  await assert.rejects(() => service.markTaskRunning("task-1", {
    stage: "chapter_execution",
    itemLabel: "running",
  }, {
    taskId: "task-1",
    attemptCount: 3,
    ownershipVersion: 7,
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
  }), (error) => error?.code === "WORKFLOW_TASK_OWNERSHIP_LOST");
  assert.equal(notifications.length, 0);
});

test("workflow write transaction rejects a command takeover after the raw ownership read", { concurrency: false }, async () => {
  const originalTransaction = prisma.$transaction;
  const store = new NovelWorkflowStoreService();
  let taskUpdates = 0;
  let notifications = 0;
  store.notifyAutoDirectorTaskTransition = async () => {
    notifications += 1;
  };
  prisma.$transaction = async (callback) => callback({
    directorRunCommand: {
      async updateMany() {
        return { count: 0 };
      },
    },
    novelWorkflowTask: {
      async updateMany() {
        taskUpdates += 1;
        return { count: 1 };
      },
      async findUnique() {
        return task({ ownershipVersion: 8 });
      },
    },
  });

  try {
    const fence = new AutoExecutionOwnershipFence({
      workflowService: {
        getDirectorCommandLeaseWithoutHealing: async () => ({
          id: "command-1",
          taskId: "task-1",
          status: "running",
          leaseOwner: "worker-a:slot-1",
          leaseExpiresAt: new Date("2099-08-11T00:00:00.000Z"),
          attempt: 3,
        }),
        getTaskByIdWithoutHealing: async () => task(),
      },
      novelService: { cancelPipelineJob: async () => undefined },
    }, "task-1", undefined, null, commandExecution());

    await assert.rejects(() => fence.runOwnedWrite((ownership) => (
      store.updateWorkflowTaskWithOwnership({
        before: task(),
        ownership,
        data: { currentItemLabel: "stale write" },
      })
    )), (error) => error?.code === "AUTO_EXECUTION_OWNERSHIP_LOST");
    assert.equal(taskUpdates, 0);
    assert.equal(notifications, 0);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("notification failure preserves the workflow ownership committed by the CAS", { concurrency: false }, async () => {
  const originalTransaction = prisma.$transaction;
  const notificationError = new Error("notification delivery failed");
  const store = new NovelWorkflowStoreService();
  let persistedOwnershipVersion = 7;
  store.notifyAutoDirectorTaskTransition = async () => {
    throw notificationError;
  };
  prisma.$transaction = async (callback) => callback({
    novelWorkflowTask: {
      async updateMany() {
        persistedOwnershipVersion = 8;
        return { count: 1 };
      },
      async findUnique() {
        return task({ ownershipVersion: persistedOwnershipVersion });
      },
    },
  });

  try {
    const fence = new AutoExecutionOwnershipFence({
      workflowService: {
        getTaskByIdWithoutHealing: async () => task({
          ownershipVersion: persistedOwnershipVersion,
        }),
      },
      novelService: { cancelPipelineJob: async () => undefined },
    }, "task-1");

    await assert.rejects(() => fence.runOwnedWrite((ownership) => (
      store.updateWorkflowTaskWithOwnership({
        before: task(),
        ownership,
        data: { currentItemLabel: "committed before notification" },
      })
    )), (error) => error === notificationError);

    const current = await fence.assertActive();
    assert.equal(current.ownershipVersion, 8);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("CAS miss after assertActive loses ownership without pipeline cleanup", { concurrency: false }, async () => {
  let cancelCalls = 0;
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getTaskByIdWithoutHealing: async () => task(),
    },
    novelService: {
      cancelPipelineJob: async () => {
        cancelCalls += 1;
      },
    },
  }, "task-1", undefined, "job-1");

  await assert.rejects(() => fence.runOwnedWrite(async () => {
    const error = new Error("retry won before write");
    error.code = "WORKFLOW_TASK_OWNERSHIP_LOST";
    throw error;
  }), (error) => error?.code === "AUTO_EXECUTION_OWNERSHIP_LOST");
  assert.equal(cancelCalls, 0);
});

test("ownership token mismatch stops the stale runner without cancelling the pipeline job", { concurrency: false }, async () => {
  let lookupCount = 0;
  let cancelCalls = 0;
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getTaskByIdWithoutHealing: async () => {
        lookupCount += 1;
        return task({ ownershipVersion: lookupCount === 1 ? 7 : 8 });
      },
    },
    novelService: {
      cancelPipelineJob: async () => {
        cancelCalls += 1;
      },
    },
  }, "task-1", undefined, "job-1");

  await fence.assertActive();
  await assert.rejects(
    () => fence.assertActive(),
    (error) => error?.code === "AUTO_EXECUTION_OWNERSHIP_LOST",
  );
  assert.equal(cancelCalls, 0);
});
