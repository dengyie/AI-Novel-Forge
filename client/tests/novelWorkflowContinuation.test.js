import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveDirectorContinueMode,
  resolveWorkflowContinuationFeedback,
} from "../src/lib/novelWorkflowContinuation.ts";

test("quality_repair currentItemKey must resume, never skip_quality_repair", () => {
  assert.equal(
    resolveDirectorContinueMode({
      checkpointType: "replan_required",
      currentItemKey: "quality_repair",
      currentStage: "质量修复",
      pendingManualRecovery: false,
    }),
    "resume",
  );
});

test("replan_required checkpoint must resume, never skip_quality_repair", () => {
  assert.equal(
    resolveDirectorContinueMode({
      checkpointType: "replan_required",
      currentItemKey: null,
      currentStage: null,
      pendingManualRecovery: false,
    }),
    "resume",
  );
});

test("quality stage label must resume, never skip_quality_repair", () => {
  assert.equal(
    resolveDirectorContinueMode({
      checkpointType: null,
      currentItemKey: null,
      currentStage: "等待质量修复确认",
      pendingManualRecovery: false,
    }),
    "resume",
  );
});

test("chapter_batch_ready continues auto_execute_range", () => {
  assert.equal(
    resolveDirectorContinueMode({
      checkpointType: "chapter_batch_ready",
      currentItemKey: null,
      currentStage: null,
      pendingManualRecovery: false,
    }),
    "auto_execute_range",
  );
});

test("pendingManualRecovery always resume", () => {
  assert.equal(
    resolveDirectorContinueMode({
      checkpointType: "chapter_batch_ready",
      currentItemKey: "quality_repair",
      currentStage: "质量",
      pendingManualRecovery: true,
    }),
    "resume",
  );
});

test("source never contains quality→skip strategy ternary", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "../src/lib/novelWorkflowContinuation.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    src,
    /currentItemKey === ["']quality_repair["'][\s\S]{0,120}\? ["']skip_quality_repair["']/,
  );
  assert.doesNotMatch(
    src,
    /checkpointType === ["']replan_required["'][\s\S]{0,120}\? ["']skip_quality_repair["']/,
  );
  assert.match(src, /禁止把质量检查点策略化映射为 skip_quality_repair/);
});

test("skip_quality_repair feedback copy retained for explicit API mode only", () => {
  const feedback = resolveWorkflowContinuationFeedback(
    { kind: "director_command_accepted", status: "running" },
    { mode: "skip_quality_repair", scopeLabel: "第3-5章" },
  );
  assert.equal(feedback.tone, "success");
  assert.match(feedback.message, /跳过本次质量建议/);
});
