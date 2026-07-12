const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveUnhandledPipelineFailureTerminalUpdate,
  buildUnhandledPipelineFailureTerminalCasWhere,
  buildPipelineJobAutoRequeueCasWhere,
} = require("../dist/services/novel/pipelineJobTerminalGuard.js");

test("resolveUnhandledPipelineFailureTerminalUpdate skips terminal and queued statuses", () => {
  for (const status of ["succeeded", "failed", "cancelled", "queued"]) {
    assert.equal(
      resolveUnhandledPipelineFailureTerminalUpdate({
        status,
        error: new Error("boom"),
      }),
      null,
      `status=${status} must not be overwritten`,
    );
  }
});

test("resolveUnhandledPipelineFailureTerminalUpdate fails running jobs with message", () => {
  assert.deepEqual(
    resolveUnhandledPipelineFailureTerminalUpdate({
      status: "running",
      error: new Error("preflight exploded"),
    }),
    { status: "failed", error: "preflight exploded" },
  );
});

test("resolveUnhandledPipelineFailureTerminalUpdate cancels when cancel flag or cancel error", () => {
  assert.deepEqual(
    resolveUnhandledPipelineFailureTerminalUpdate({
      status: "running",
      cancelRequestedAt: new Date(),
      error: new Error("anything"),
    }),
    { status: "cancelled", error: null },
  );
  assert.deepEqual(
    resolveUnhandledPipelineFailureTerminalUpdate({
      status: "running",
      error: new Error("PIPELINE_CANCELLED"),
    }),
    { status: "cancelled", error: null },
  );
  assert.deepEqual(
    resolveUnhandledPipelineFailureTerminalUpdate({
      status: "running",
      error: Object.assign(new Error("Request aborted."), { name: "AbortError" }),
    }),
    { status: "cancelled", error: null },
  );
  // plain Error("aborted") / bare AbortError → cancelled（与 transport 对齐）
  assert.deepEqual(
    resolveUnhandledPipelineFailureTerminalUpdate({
      status: "running",
      error: new Error("aborted"),
    }),
    { status: "cancelled", error: null },
  );
  assert.deepEqual(
    resolveUnhandledPipelineFailureTerminalUpdate({
      status: "running",
      error: Object.assign(new Error("wall clock"), { name: "AbortError" }),
    }),
    { status: "cancelled", error: null },
  );
});

test("resolveUnhandledPipelineFailureTerminalUpdate uses fallback message for empty errors", () => {
  assert.deepEqual(
    resolveUnhandledPipelineFailureTerminalUpdate({
      status: "running",
      error: null,
    }),
    { status: "failed", error: "流水线执行异常（调度兜底）" },
  );
});

test("terminal and requeue CAS where only match running (and requeue requires no cancel)", () => {
  assert.deepEqual(buildUnhandledPipelineFailureTerminalCasWhere("job-1"), {
    id: "job-1",
    status: "running",
  });
  assert.deepEqual(buildPipelineJobAutoRequeueCasWhere("job-2"), {
    id: "job-2",
    status: "running",
    cancelRequestedAt: null,
  });
});
