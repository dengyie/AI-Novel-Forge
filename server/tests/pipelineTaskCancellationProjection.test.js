const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  PipelineTaskAdapter,
} = require("../dist/services/task/adapters/PipelineTaskAdapter.js");

test("a cancellation race that already succeeded does not cancel the linked director task", async () => {
  const originals = {
    archiveFindUnique: prisma.taskCenterArchive.findUnique,
    workflowFindFirst: prisma.novelWorkflowTask.findFirst,
  };
  let linkedTaskLookups = 0;
  let workflowCancelCalls = 0;

  try {
    prisma.taskCenterArchive.findUnique = async () => null;
    prisma.novelWorkflowTask.findFirst = async () => {
      linkedTaskLookups += 1;
      return { id: "director-task-1" };
    };

    const adapter = new PipelineTaskAdapter({
      retryPipelineJob: async () => {
        throw new Error("not used");
      },
      cancelPipelineJob: async () => ({
        id: "pipeline-1",
        novelId: "novel-1",
        status: "succeeded",
      }),
    });
    adapter.detail = async () => ({
      id: "pipeline-1",
      kind: "novel_pipeline",
      status: "succeeded",
      meta: {},
      steps: [],
    });
    adapter.workflowService.cancelTask = async () => {
      workflowCancelCalls += 1;
    };

    const detail = await adapter.cancel("pipeline-1");

    assert.equal(detail.status, "succeeded");
    assert.equal(linkedTaskLookups, 0);
    assert.equal(workflowCancelCalls, 0);
  } finally {
    prisma.taskCenterArchive.findUnique = originals.archiveFindUnique;
    prisma.novelWorkflowTask.findFirst = originals.workflowFindFirst;
  }
});
