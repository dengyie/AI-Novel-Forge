const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveContiguousWindowFromOrders,
  resolveNextUnpreparedWindow,
  resolveNextPreparedExecutableWindow,
  resolveNextAutoExecutionBatchRoll,
  applyExpandRangeBatchRoll,
  DEFAULT_MAX_CONSECUTIVE_BATCH_ROLLS,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionBatchRollRuntime.js");

test("resolveContiguousWindowFromOrders groups contiguous orders after cursor", () => {
  const window = resolveContiguousWindowFromOrders([21, 22, 23, 25, 26], 20, 10);
  assert.deepEqual(window, { startOrder: 21, endOrder: 23 });
});

test("resolveNextUnpreparedWindow picks first unprepared contiguous band", () => {
  const readiness = [
    { order: 11, hasTitle: true, canEnterExecution: true, isProcessed: true },
    { order: 20, hasTitle: true, canEnterExecution: true, isProcessed: true },
    { order: 21, hasTitle: true, canEnterExecution: false, isProcessed: false },
    { order: 22, hasTitle: true, canEnterExecution: false, isProcessed: false },
    { order: 23, hasTitle: true, canEnterExecution: false, isProcessed: false },
  ];
  assert.deepEqual(
    resolveNextUnpreparedWindow({ afterOrder: 20, readiness }),
    { startOrder: 21, endOrder: 23 },
  );
});

test("resolveNextPreparedExecutableWindow requires remaining work", () => {
  const readiness = [
    { order: 21, hasTitle: true, canEnterExecution: true, isProcessed: true },
    { order: 22, hasTitle: true, canEnterExecution: true, isProcessed: true },
    { order: 31, hasTitle: true, canEnterExecution: true, isProcessed: false },
    { order: 32, hasTitle: true, canEnterExecution: true, isProcessed: false },
  ];
  assert.deepEqual(
    resolveNextPreparedExecutableWindow({ afterOrder: 20, readiness }),
    { startOrder: 31, endOrder: 32 },
  );
});

test("resolveNextAutoExecutionBatchRoll expands when next prepared window exists", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: "c11" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range", startOrder: 11, endOrder: 20 },
    consecutiveBatchRolls: 0,
    nextPreparedExecutableWindow: { startOrder: 21, endOrder: 30 },
  });
  assert.equal(decision.kind, "expand_range");
  assert.deepEqual(decision.nextRange, { startOrder: 21, endOrder: 30 });
});

test("resolveNextAutoExecutionBatchRoll reenters outline for unprepared window", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: "c11" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range" },
    consecutiveBatchRolls: 0,
    nextUnpreparedWindow: { startOrder: 21, endOrder: 30 },
    canPrepareNextBatch: true,
  });
  assert.equal(decision.kind, "reenter_structured_outline");
});

test("resolveNextAutoExecutionBatchRoll completes when no next window", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 31, endOrder: 40, totalChapterCount: 10, firstChapterId: "c31" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range" },
    consecutiveBatchRolls: 0,
  });
  assert.equal(decision.kind, "completed_scope");
});

test("resolveNextAutoExecutionBatchRoll halts on prose_complete_only without next window", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 31, endOrder: 40, totalChapterCount: 10, firstChapterId: "c31" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range" },
    consecutiveBatchRolls: 0,
    volumeCompletionKind: "prose_complete_only",
    supervisoryCloseable: false,
  });
  assert.equal(decision.kind, "halt_for_review");
  assert.match(decision.reason, /prose_complete_only|功能验收/);
});

test("resolveNextAutoExecutionBatchRoll still expands when prose_complete_only but next window ready", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: "c11" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range", startOrder: 11, endOrder: 20 },
    consecutiveBatchRolls: 0,
    nextPreparedExecutableWindow: { startOrder: 21, endOrder: 30 },
    volumeCompletionKind: "prose_complete_only",
  });
  // 有下一窗时优先 expand，不在中段因卷完成态 halt
  assert.equal(decision.kind, "expand_range");
});

test("resolveNextAutoExecutionBatchRoll setting_complete remains completed_scope", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 31, endOrder: 40, totalChapterCount: 10, firstChapterId: "c31" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range" },
    consecutiveBatchRolls: 0,
    volumeCompletionKind: "setting_complete",
    supervisoryCloseable: true,
  });
  assert.equal(decision.kind, "completed_scope");
});

test("resolveNextAutoExecutionBatchRoll halts after max consecutive rolls", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 1, endOrder: 10, totalChapterCount: 10, firstChapterId: "c1" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range" },
    consecutiveBatchRolls: DEFAULT_MAX_CONSECUTIVE_BATCH_ROLLS,
    nextPreparedExecutableWindow: { startOrder: 11, endOrder: 20 },
  });
  assert.equal(decision.kind, "halt_for_review");
});

test("applyExpandRangeBatchRoll rebuilds state for next window and clears pipeline job", () => {
  const chapters = [21, 22, 23].map((order) => ({
    id: `chapter-${order}`,
    order,
    content: null,
    generationState: "planned",
    chapterStatus: "pending_generation",
    riskFlags: null,
    taskSheet: `第${order}章任务单`,
    sceneCards: "{}",
    conflictLevel: 2,
    revealLevel: 1,
    targetWordCount: 2800,
    mustAvoid: "无",
  }));
  const previousState = {
    enabled: true,
    mode: "chapter_range",
    startOrder: 11,
    endOrder: 20,
    remainingChapterCount: 0,
    skippedChapterIds: ["chapter-15"],
    skippedChapterOrders: [15],
    qualityDebtChapterIds: [],
    qualityDebtChapterOrders: [],
    qualityDebtSummaries: [],
    pipelineJobId: "old-job",
    pipelineStatus: "succeeded",
    autoReview: true,
    autoRepair: true,
  };
  const { range, autoExecution } = applyExpandRangeBatchRoll({
    previousState,
    nextRange: { startOrder: 21, endOrder: 23 },
    chapters,
  });
  assert.equal(range.startOrder, 21);
  assert.equal(range.endOrder, 23);
  assert.equal(autoExecution.pipelineJobId, null);
  assert.equal(autoExecution.startOrder, 21);
  assert.equal(autoExecution.endOrder, 23);
  assert.ok((autoExecution.remainingChapterCount ?? 0) >= 1);
  // Cross-window historical skips must survive expand (not only in-window canPreserve).
  assert.deepEqual(autoExecution.skippedChapterIds, ["chapter-15"]);
  assert.deepEqual(autoExecution.skippedChapterOrders, [15]);
});
