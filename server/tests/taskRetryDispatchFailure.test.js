const test = require("node:test");
const assert = require("node:assert/strict");

const { NovelWorkflowTaskAdapter } = require("../dist/services/task/adapters/NovelWorkflowTaskAdapter.js");
const { prisma } = require("../dist/db/prisma.js");

test("retry command acceptance failure is propagated without a second compensation mutation", async () => {
  const adapter = new NovelWorkflowTaskAdapter();
  const calls = [];
  const task = {
    id: "workflow-retry-failure",
    lane: "auto_director",
    status: "failed",
    attemptCount: 2,
  };
  const originalArchiveFindUnique = prisma.taskCenterArchive.findUnique;
  const originalGetTaskByIdWithoutHealing = adapter.workflowService.getTaskByIdWithoutHealing;
  const originalEnqueueRetryCommand = adapter.directorCommandService.enqueueRetryCommand;
  const originalMarkRetryDispatchFailed = adapter.workflowService.markRetryDispatchFailed;

  prisma.taskCenterArchive.findUnique = async () => null;
  adapter.workflowService.getTaskByIdWithoutHealing = async () => task;
  adapter.directorCommandService.enqueueRetryCommand = async (input) => {
    calls.push(["enqueueRetryCommand", input]);
    throw new Error("command create failed");
  };
  adapter.workflowService.markRetryDispatchFailed = async () => {
    calls.push(["markRetryDispatchFailed"]);
  };

  try {
    await assert.rejects(
      () => adapter.retry({ id: task.id, resume: true }),
      /command create failed/,
    );
    assert.deepEqual(calls, [
      ["enqueueRetryCommand", {
        taskId: task.id,
        llmOverride: undefined,
        batchAlreadyStartedCount: undefined,
      }],
    ], "atomic retry owns rollback; the adapter must not issue a second state compensation");
  } finally {
    prisma.taskCenterArchive.findUnique = originalArchiveFindUnique;
    adapter.workflowService.getTaskByIdWithoutHealing = originalGetTaskByIdWithoutHealing;
    adapter.directorCommandService.enqueueRetryCommand = originalEnqueueRetryCommand;
    adapter.workflowService.markRetryDispatchFailed = originalMarkRetryDispatchFailed;
  }
});
