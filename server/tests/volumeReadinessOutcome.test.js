const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapRepairOutcome,
  mapRepairOutcomeFromFrames,
} = require("../dist/services/novel/volume/VolumeReadinessExecutor.js");

test("mapRepairOutcome: empty → failed (fail-closed, not adopt)", () => {
  assert.equal(mapRepairOutcome(null), "failed");
  assert.equal(mapRepairOutcome(""), "failed");
});

test("mapRepairOutcomeFromFrames: discard / plateau / adopt succeeded", () => {
  assert.equal(
    mapRepairOutcomeFromFrames([{
      phase: "completed",
      status: "succeeded",
      message: "修复候选未采纳（discard）：score worse 正文保持 baseline。",
    }]).outcome,
    "repair_discarded",
  );
  assert.equal(
    mapRepairOutcomeFromFrames([{
      phase: "completed",
      status: "succeeded",
      message: "修复候选未采纳（plateau）：连续无提升 正文保持 baseline。",
    }]).outcome,
    "repair_plateau",
  );
  assert.equal(
    mapRepairOutcomeFromFrames([{
      phase: "completed",
      status: "succeeded",
      message: "修复候选已采纳，本章已达到可继续推进状态。",
    }]).outcome,
    "repair_adopted",
  );
});

test("mapRepairOutcomeFromFrames: adopt but status failed → repair_incomplete", () => {
  assert.equal(
    mapRepairOutcomeFromFrames([{
      phase: "completed",
      status: "failed",
      message: "修复候选已采纳并保存，但仍有问题待继续处理。",
    }]).outcome,
    "repair_incomplete",
  );
  assert.equal(
    mapRepairOutcomeFromFrames([{
      phase: "completed",
      status: "failed",
      message: "修复候选已采纳，但 artifacts 同步失败，已标 needs_repair。",
    }]).outcome,
    "repair_incomplete",
  );
});

test("mapRepairOutcomeFromFrames: adopt message with 仍有问题 even without status → incomplete", () => {
  assert.equal(
    mapRepairOutcomeFromFrames([{
      phase: "completed",
      message: "修复候选已采纳并保存，但仍有问题待继续处理。",
    }]).outcome,
    "repair_incomplete",
  );
});

test("mapRepairOutcomeFromFrames: unknown message → failed", () => {
  assert.equal(
    mapRepairOutcomeFromFrames([{ phase: "completed", message: "something weird happened" }]).outcome,
    "failed",
  );
});

test("mapRepairOutcomeFromFrames: prefers last completed frame status", () => {
  assert.equal(
    mapRepairOutcomeFromFrames([
      { phase: "streaming", status: "running", message: "streaming" },
      { phase: "completed", status: "failed", message: "修复候选已采纳并保存，但仍有问题待继续处理。" },
    ]).outcome,
    "repair_incomplete",
  );
});

test("mapRepairOutcomeFromFrames: finalizing-only frames fail-closed (no completed)", () => {
  // #7：旧实现会把 finalizing 文案里的「采纳」误判成 adopt
  assert.equal(
    mapRepairOutcomeFromFrames([{
      phase: "finalizing",
      status: "running",
      message: "修复稿已生成，正在评估是否采纳（evaluate → adopt|discard）。",
    }]).outcome,
    "failed",
  );
  assert.equal(
    mapRepairOutcomeFromFrames([
      { phase: "streaming", status: "running", message: "streaming" },
      { phase: "finalizing", status: "running", message: "正在评估是否采纳" },
    ]).outcome,
    "failed",
  );
});
