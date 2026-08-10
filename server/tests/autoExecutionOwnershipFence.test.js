const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AutoExecutionOwnershipFence,
} = require("../dist/services/novel/director/automation/domain/AutoExecutionOwnershipFence.js");
const {
  NovelWorkflowApplicationService,
} = require("../dist/services/novel/workflow/NovelWorkflowApplicationService.js");

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
