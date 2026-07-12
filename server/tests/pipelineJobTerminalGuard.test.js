const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveUnhandledPipelineFailureTerminalUpdate,
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
