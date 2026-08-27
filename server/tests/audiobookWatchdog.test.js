/**
 * R1/R3 watchdog 纯逻辑单测。
 *
 * 测 computeWatchdogDecision / projectWatchdogSignal / watchdogSignalEqual 三个导出纯函数。
 * 不 mock prisma——runWatchdogTick 的 DB+CAS 依赖真表，记 Manual-required。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  projectWatchdogSignal,
  watchdogSignalEqual,
  computeWatchdogDecision,
  isWatchdogFinalizingTolerant,
  AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS,
} = require("../dist/services/audiobook/AudiobookTaskService.js");

// ── projectWatchdogSignal ──

test("projectWatchdogSignal: 正常行投影五元组", () => {
  const signal = projectWatchdogSignal({
    progress: 42,
    currentStage: "synthesizing",
    currentItemKey: "chunk-7",
    completedChapterCount: 3,
    progressJson: JSON.stringify({ completedChunks: 15 }),
  });
  assert.deepEqual(signal, {
    progress: 42,
    stage: "synthesizing",
    itemKey: "chunk-7",
    completedChapters: 3,
    completedChunks: 15,
  });
});

test("projectWatchdogSignal: null 字段降级为默认值", () => {
  const signal = projectWatchdogSignal({
    progress: null,
    currentStage: null,
    currentItemKey: null,
    completedChapterCount: null,
    progressJson: null,
  });
  assert.deepEqual(signal, {
    progress: 0,
    stage: null,
    itemKey: null,
    completedChapters: 0,
    completedChunks: 0,
  });
});

test("projectWatchdogSignal: progressJson 无 completedChunks 字段 → 0", () => {
  const signal = projectWatchdogSignal({
    progress: 10,
    currentStage: "annotating",
    currentItemKey: null,
    completedChapterCount: 1,
    progressJson: JSON.stringify({ foo: "bar" }),
  });
  assert.equal(signal.completedChunks, 0);
});

test("projectWatchdogSignal: progressJson 损坏 → completedChunks=0", () => {
  const signal = projectWatchdogSignal({
    progress: 10,
    currentStage: "annotating",
    currentItemKey: null,
    completedChapterCount: 1,
    progressJson: "{{invalid json",
  });
  assert.equal(signal.completedChunks, 0);
});

test("projectWatchdogSignal: 截断超长 stage/itemKey", () => {
  const longStage = "a".repeat(100);
  const longKey = "b".repeat(100);
  const signal = projectWatchdogSignal({
    progress: 50,
    currentStage: longStage,
    currentItemKey: longKey,
    completedChapterCount: 2,
    progressJson: null,
  });
  assert.equal(signal.stage.length, 32);
  assert.equal(signal.itemKey.length, 40);
});

// ── watchdogSignalEqual ──

test("watchdogSignalEqual: 相同信号 → true", () => {
  const a = { progress: 10, stage: "s", itemKey: "k", completedChapters: 1, completedChunks: 5 };
  const b = { ...a };
  assert.equal(watchdogSignalEqual(a, b), true);
});

test("watchdogSignalEqual: 不同 progress → false", () => {
  const a = { progress: 10, stage: "s", itemKey: "k", completedChapters: 1, completedChunks: 5 };
  const b = { ...a, progress: 11 };
  assert.equal(watchdogSignalEqual(a, b), false);
});

test("watchdogSignalEqual: 不同 completedChunks → false", () => {
  const a = { progress: 10, stage: "s", itemKey: "k", completedChapters: 1, completedChunks: 5 };
  const b = { ...a, completedChunks: 6 };
  assert.equal(watchdogSignalEqual(a, b), false);
});

// ── computeWatchdogDecision ──

test("computeWatchdogDecision: 首次（prev=null）不 fail", () => {
  const curr = { progress: 0, stage: null, itemKey: null, completedChapters: 0, completedChunks: 0 };
  const result = computeWatchdogDecision({ prev: null, curr, stallPeriods: 3 });
  assert.equal(result.stallCount, 0);
  assert.equal(result.fail, false);
  assert.deepEqual(result.signal, curr);
});

test("computeWatchdogDecision: 连续 N 周期不变 → fail=true", () => {
  const signal = { progress: 42, stage: "synth", itemKey: "c-1", completedChapters: 2, completedChunks: 10 };
  const stallPeriods = 3;

  // 第 1 轮：stallCount 0→1
  const r1 = computeWatchdogDecision({ prev: { signal, stallCount: 0 }, curr: signal, stallPeriods });
  assert.equal(r1.stallCount, 1);
  assert.equal(r1.fail, false);

  // 第 2 轮：stallCount 1→2
  const r2 = computeWatchdogDecision({ prev: { signal, stallCount: 1 }, curr: signal, stallPeriods });
  assert.equal(r2.stallCount, 2);
  assert.equal(r2.fail, false);

  // 第 3 轮：stallCount 2→3 ≥ stallPeriods → fail
  const r3 = computeWatchdogDecision({ prev: { signal, stallCount: 2 }, curr: signal, stallPeriods });
  assert.equal(r3.stallCount, 3);
  assert.equal(r3.fail, true);
});

test("computeWatchdogDecision: 信号变化 → 重置 stallCount", () => {
  const old = { progress: 42, stage: "synth", itemKey: "c-1", completedChapters: 2, completedChunks: 10 };
  const updated = { ...old, completedChunks: 11 };
  const result = computeWatchdogDecision({ prev: { signal: old, stallCount: 4 }, curr: updated, stallPeriods: 5 });
  assert.equal(result.stallCount, 0);
  assert.equal(result.fail, false);
  assert.deepEqual(result.signal, updated);
});

test("computeWatchdogDecision: stallPeriods=2 → 第 2 周期即 fail", () => {
  const signal = { progress: 0, stage: null, itemKey: null, completedChapters: 0, completedChunks: 0 };
  const r = computeWatchdogDecision({ prev: { signal, stallCount: 1 }, curr: signal, stallPeriods: 2 });
  assert.equal(r.stallCount, 2);
  assert.equal(r.fail, true);
});

test("computeWatchdogDecision: progress 推进足以重置（仅 progress 变 ≠ 全停滞）", () => {
  const old = { progress: 10, stage: "annotating", itemKey: null, completedChapters: 0, completedChunks: 0 };
  const updated = { ...old, progress: 11 };
  const r = computeWatchdogDecision({ prev: { signal: old, stallCount: 3 }, curr: updated, stallPeriods: 5 });
  assert.equal(r.stallCount, 0);
  assert.equal(r.fail, false);
});

// ── isWatchdogFinalizingTolerant（R2-2 finalizing/m4b 放宽容忍）──

test("isWatchdogFinalizingTolerant: finalizing+progress>=98 → true", () => {
  assert.equal(
    isWatchdogFinalizingTolerant({ currentStage: "finalizing", progress: 98 }),
    true,
  );
});

test("isWatchdogFinalizingTolerant: finalizing+progress=97 → false（尚未越过合成）", () => {
  assert.equal(
    isWatchdogFinalizingTolerant({ currentStage: "finalizing", progress: 97 }),
    false,
  );
});

test("isWatchdogFinalizingTolerant: 非 finalizing → false", () => {
  assert.equal(
    isWatchdogFinalizingTolerant({ currentStage: "synthesizing", progress: 50 }),
    false,
  );
});

test("isWatchdogFinalizingTolerant: m4b 编码中（.part 存在）→ true", () => {
  assert.equal(
    isWatchdogFinalizingTolerant({ currentStage: "finalizing", progress: 95, m4bEncodingOnDisk: true }),
    true,
  );
});

test("isWatchdogFinalizingTolerant: progress null 不误判", () => {
  assert.equal(isWatchdogFinalizingTolerant({ currentStage: "finalizing", progress: null }), false);
});

test("AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS: 默认 ≥ 40（40min 宽限）", () => {
  assert.ok(AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS >= 40);
});

// 模拟 finalizing 中五元组停滞 10 个周期（旧逻辑必杀）→ 用宽限阈值 40 周期仍不杀
// 注意：computeWatchdogDecision 对 prev=null 的首次调用返回 stallCount=0，
// 因此执行 10 次后实际计到 9 个停滞周期；断言按语义写（fail=false + 实际计数）。
test("computeWatchdogDecision finalizing: 10 周期停滞仍不 fail（宽限 40）", () => {
  const signal = { progress: 98, stage: "finalizing", itemKey: "ch-19", completedChapters: 19, completedChunks: 200 };
  let prev = null;
  let result;
  for (let i = 0; i < 10; i += 1) {
    result = computeWatchdogDecision({ prev, curr: signal, stallPeriods: AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS });
    prev = { signal: result.signal, stallCount: result.stallCount };
  }
  assert.equal(result.fail, false);
  assert.ok(result.stallCount >= 9, "10 次调用应至少累计 9 个停滞周期");
  assert.ok(result.stallCount < AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS);
});
