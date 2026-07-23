const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectWorkflowLinkedPipelineIds,
} = require("../dist/services/task/taskCenterVisibility.js");

test("collectWorkflowLinkedPipelineIds ignores failed and cancelled workflow wrappers", () => {
  const linkedIds = collectWorkflowLinkedPipelineIds([
    {
      id: "workflow-running",
      kind: "novel_workflow",
      status: "running",
      targetResources: [{ type: "generation_job", id: "job-running" }],
    },
    {
      id: "workflow-failed",
      kind: "novel_workflow",
      status: "failed",
      targetResources: [{ type: "generation_job", id: "job-failed" }],
    },
    {
      id: "workflow-cancelled",
      kind: "novel_workflow",
      status: "cancelled",
      targetResources: [{ type: "generation_job", id: "job-cancelled" }],
    },
  ]);

  assert.deepEqual([...linkedIds], ["job-running"]);
});

test("collectWorkflowLinkedPipelineIds includes waiting/queued/succeeded and trims ids", () => {
  const linkedIds = collectWorkflowLinkedPipelineIds([
    {
      id: "wf-wait",
      kind: "novel_workflow",
      status: "waiting_approval",
      targetResources: [{ type: "generation_job", id: "  job-wait  " }],
    },
    {
      id: "wf-ok",
      kind: "novel_workflow",
      status: "succeeded",
      targetResources: [{ type: "generation_job", id: "job-ok" }],
    },
    {
      id: "wf-queued",
      kind: "novel_workflow",
      status: "queued",
      targetResources: [{ type: "generation_job", id: "job-queued" }],
    },
    {
      id: "pipeline-self",
      kind: "novel_pipeline",
      status: "running",
      targetResources: [{ type: "generation_job", id: "should-ignore" }],
    },
  ]);

  assert.deepEqual([...linkedIds].sort(), ["job-ok", "job-queued", "job-wait"]);
});
