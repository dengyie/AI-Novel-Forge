const test = require("node:test");
const assert = require("node:assert/strict");

const {
  schedulePendingReviewAutoPromotionIfEnabled,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionRuntime.js");

test("pending review auto-promotion scheduler does not call service when disabled", async () => {
  let calls = 0;

  await schedulePendingReviewAutoPromotionIfEnabled({
    isPendingReviewAutoPromotionEnabled: async () => false,
    autoPromotePendingReviewProposals: async () => {
      calls += 1;
    },
  }, {
    novelId: "novel-1",
    taskId: "task-1",
  });
  assert.equal(calls, 0);
});

test("pending review auto-promotion scheduler calls service when enabled", async () => {
  const calls = [];

  await schedulePendingReviewAutoPromotionIfEnabled({
    isPendingReviewAutoPromotionEnabled: () => true,
    autoPromotePendingReviewProposals: async (input) => {
      calls.push(input);
    },
  }, {
    novelId: "novel-1",
    taskId: "task-1",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].novelId, "novel-1");
  assert.equal(calls[0].taskId, "task-1");
  assert.equal(typeof calls[0].beforeCommit, "function");
});

test("pending review auto-promotion scheduler propagates promotion errors", async () => {
  const infrastructureError = new Error("proposal store unavailable");

  await assert.rejects(() => schedulePendingReviewAutoPromotionIfEnabled({
    isPendingReviewAutoPromotionEnabled: () => true,
    autoPromotePendingReviewProposals: async () => {
      throw infrastructureError;
    },
  }, {
    novelId: "novel-1",
    taskId: "task-1",
  }), (error) => error === infrastructureError);
});
