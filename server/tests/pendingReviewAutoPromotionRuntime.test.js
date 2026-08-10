const test = require("node:test");
const assert = require("node:assert/strict");

const {
  schedulePendingReviewAutoPromotionIfEnabled,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionRuntime.js");
const {
  AutoExecutionOwnershipFence,
} = require("../dist/services/novel/director/automation/domain/AutoExecutionOwnershipFence.js");

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
      return { ownership: null };
    },
  }, {
    novelId: "novel-1",
    taskId: "task-1",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].novelId, "novel-1");
  assert.equal(calls[0].taskId, "task-1");
  assert.equal(calls[0].beforeCommit, undefined);
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

test("pending review auto-promotion carries and refreshes the transaction ownership snapshot", async () => {
  let ownershipVersion = 4;
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      async getTaskByIdWithoutHealing() {
        return {
          status: "running",
          attemptCount: 2,
          ownershipVersion,
          updatedAt: new Date(),
          cancelRequestedAt: null,
        };
      },
    },
    novelService: { async cancelPipelineJob() {} },
  }, "task-1");

  await schedulePendingReviewAutoPromotionIfEnabled({
    isPendingReviewAutoPromotionEnabled: () => true,
    autoPromotePendingReviewProposals: async (input) => {
      assert.deepEqual(input.ownership, {
        taskId: "task-1",
        attemptCount: 2,
        ownershipVersion: 4,
      });
      ownershipVersion += 1;
      return {
        ownership: {
          taskId: "task-1",
          attemptCount: 2,
          ownershipVersion,
        },
      };
    },
  }, {
    novelId: "novel-1",
    taskId: "task-1",
    ownershipFence: fence,
  });

  await fence.assertActive();
});
