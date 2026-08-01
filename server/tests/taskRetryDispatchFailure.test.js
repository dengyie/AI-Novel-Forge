const test = require("node:test");
const assert = require("node:assert/strict");

const { NovelWorkflowTaskAdapter } = require("../dist/services/task/adapters/NovelWorkflowTaskAdapter.js");

test("retry dispatch failure marks the claimed task failed and recoverable", async () => {
  const adapter = new NovelWorkflowTaskAdapter();
  const calls = [];
  const claimed = { id: "workflow-retry-failure", attemptCount: 3 };
  const recovered = {
    id: claimed.id,
    status: "failed",
    pendingManualRecovery: true,
    attemptCount: claimed.attemptCount,
    lastError: "重试任务入队失败：queue unavailable",
  };

  adapter.workflowService = {
    getTaskById: async () => ({
      id: claimed.id,
      lane: "auto_director",
      status: "failed",
      attemptCount: 2,
      checkpointType: null,
    }),
    retryTask: async () => claimed,
    markRetryDispatchFailed: async (id, attemptCount, error) => {
      calls.push(["markRetryDispatchFailed", id, attemptCount, error.message]);
      return recovered;
    },
  };
  adapter.novelDirectorService.continueTask = async () => {
    throw new Error("queue unavailable");
  };
  adapter.detail = async (id) => {
    calls.push(["detail", id]);
    return recovered;
  };

  await assert.rejects(
    () => adapter.retry({ id: claimed.id, resume: true }),
    /queue unavailable/,
  );
  assert.deepEqual(calls, [
    ["markRetryDispatchFailed", claimed.id, claimed.attemptCount, "queue unavailable"],
  ], "dispatch failure must be reconciled instead of leaving a queued orphan");
});
