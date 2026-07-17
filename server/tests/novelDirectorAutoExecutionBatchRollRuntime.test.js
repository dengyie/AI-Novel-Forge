const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveContiguousWindowFromOrders,
  resolveNextUnpreparedWindow,
  resolveNextPreparedExecutableWindow,
  resolveNextAutoExecutionBatchRoll,
  applyExpandRangeBatchRoll,
  mergeWorkspaceChapterWithExecRow,
  buildBatchRollReadinessFromChapters,
  DEFAULT_MAX_CONSECUTIVE_BATCH_ROLLS,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionBatchRollRuntime.js");

const {
  isDirectorAutoExecutionChapterProcessed,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecution.js");

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

function buildValidSceneCards(targetWordCount = 2800) {
  const third = Math.floor(targetWordCount / 3);
  return JSON.stringify({
    targetWordCount,
    lengthBudget: {
      targetWordCount,
      softMinWordCount: Math.floor(targetWordCount * 0.85),
      softMaxWordCount: Math.floor(targetWordCount * 1.15),
      hardMaxWordCount: Math.floor(targetWordCount * 1.25),
    },
    scenes: [
      {
        key: "scene-1",
        title: "入口压力",
        purpose: "让主角被迫正面处理新的资源危机。",
        mustAdvance: ["暴露危机来源"],
        mustPreserve: ["不提前解决最终对手"],
        entryState: "主角刚拿到异常线索。",
        exitState: "主角确认危机来自内部。",
        forbiddenExpansion: ["不要直接揭开幕后人身份"],
        targetWordCount: third,
      },
      {
        key: "scene-2",
        title: "主动试探",
        purpose: "让主角用低成本方案试探对方底线。",
        mustAdvance: ["获得一个可验证证据"],
        mustPreserve: ["保留关系张力"],
        entryState: "主角掌握第一条线索。",
        exitState: "对手被迫露出反常反应。",
        forbiddenExpansion: ["不要让冲突直接收束"],
        targetWordCount: third,
      },
      {
        key: "scene-3",
        title: "结尾钩子",
        purpose: "把局面推到下一章入口。",
        mustAdvance: ["留下更大的追查方向"],
        mustPreserve: ["不兑现下一章核心事件"],
        entryState: "主角确认对手有破绽。",
        exitState: "新证据指向更危险的入口。",
        forbiddenExpansion: ["不要提前解决下一章标题事件"],
        targetWordCount: targetWordCount - 2 * third,
      },
    ],
  });
}

function contractReadyPlan(order) {
  return {
    chapterOrder: order,
    chapterId: `plan-${order}`,
    id: `ws-${order}`,
    title: `第${order}章 危机试探`,
    purpose: `推进第${order}章主线：从被动承压转为主动试探。`,
    exclusiveEvent: `第${order}章主角第一次确认资源危机来自内部。`,
    endingState: `第${order}章末主角拿到第一份证据。`,
    nextChapterEntryState: `第${order + 1}章入口：主角带着证据进入下一轮试探。`,
    conflictLevel: 45,
    revealLevel: 35,
    targetWordCount: 2800,
    mustAvoid: "不要提前揭示幕后主使，不要复写下一章核心事件。",
    taskSheet: [
      `【本章独占事件】第${order}章主角第一次确认资源危机来自内部。`,
      "【在场人物】主角必须露脸；幕后主使故意 offscreen。",
      "【人物选择】主角在公开对质与私下取证之间做有代价的选择，押上内部人脉。",
      "【现场压力】雨夜仓库潮气与警报灯把身体与社会压力压到同一现场。",
      "【禁止】不要提前揭示幕后主使，不要复写下一章核心事件。",
    ].join("\n"),
    sceneCards: buildValidSceneCards(2800),
  };
}

test("mergeWorkspaceChapterWithExecRow keeps exec content so isProcessed can be true", () => {
  const plan = contractReadyPlan(21);
  const execRow = {
    id: "chapter-21",
    order: 21,
    content: "已写正文，不可被 plan 覆盖成 null。",
    generationState: "approved",
    chapterStatus: "completed",
    riskFlags: null,
    taskSheet: "exec-task-sheet",
    conflictLevel: 3,
  };
  const merged = mergeWorkspaceChapterWithExecRow(plan, execRow);
  assert.equal(merged.id, "chapter-21");
  assert.equal(merged.content, "已写正文，不可被 plan 覆盖成 null。");
  assert.equal(merged.generationState, "approved");
  assert.equal(merged.chapterStatus, "completed");
  assert.equal(merged.purpose, plan.purpose);
  // plan-first contract scalar, not exec overwrite
  assert.equal(merged.conflictLevel, 45);
  assert.equal(merged.taskSheet, plan.taskSheet);
  assert.equal(isDirectorAutoExecutionChapterProcessed(merged), true);
});

test("mergeWorkspaceChapterWithExecRow does not invent content when exec missing", () => {
  const merged = mergeWorkspaceChapterWithExecRow(contractReadyPlan(31), null);
  assert.equal(merged.content, null);
  assert.equal(merged.id, "plan-31");
  assert.equal(isDirectorAutoExecutionChapterProcessed(merged), false);
});

test("merge+readiness: fully processed prepared window does not thrash expand", () => {
  // Production thrash shape: workspace has contract for 21–30, exec has approved prose.
  // Old path hard-coded content:null → isProcessed false → fake expand forever.
  const chapters = [];
  for (let order = 21; order <= 30; order += 1) {
    chapters.push(mergeWorkspaceChapterWithExecRow(
      contractReadyPlan(order),
      {
        id: `chapter-${order}`,
        order,
        content: `第${order}章正文`,
        generationState: "approved",
        chapterStatus: "completed",
        riskFlags: null,
      },
    ));
  }
  const readiness = buildBatchRollReadinessFromChapters(chapters);
  assert.ok(readiness.every((item) => item.isProcessed), "merged approved chapters must count as processed");
  assert.ok(
    readiness.every((item) => item.canEnterExecution),
    "contract-ready fixtures must pass canEnter so unprepared path is not confused with thrash",
  );
  const prepared = resolveNextPreparedExecutableWindow({ afterOrder: 20, readiness });
  assert.equal(prepared, null, "no unprocessed work → no prepared executable window");
  const unprepared = resolveNextUnpreparedWindow({ afterOrder: 20, readiness });
  assert.equal(unprepared, null, "processed+canEnter chapters are not unprepared");
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: "c11" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range", startOrder: 11, endOrder: 20 },
    consecutiveBatchRolls: 0,
    nextPreparedExecutableWindow: prepared,
    nextUnpreparedWindow: unprepared,
  });
  assert.equal(decision.kind, "completed_scope");
});

test("merge+readiness: unprocessed prepared window still expands", () => {
  const chapters = [21, 22].map((order) => mergeWorkspaceChapterWithExecRow(
    contractReadyPlan(order),
    {
      id: `chapter-${order}`,
      order,
      content: null,
      generationState: "planned",
      chapterStatus: "pending_generation",
      riskFlags: null,
    },
  ));
  const readiness = buildBatchRollReadinessFromChapters(chapters);
  assert.ok(readiness.every((item) => item.canEnterExecution), "contract-ready chapters must pass canEnter");
  assert.ok(readiness.every((item) => !item.isProcessed));
  const prepared = resolveNextPreparedExecutableWindow({ afterOrder: 20, readiness });
  assert.deepEqual(prepared, { startOrder: 21, endOrder: 22 });
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: "c11" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range" },
    consecutiveBatchRolls: 0,
    nextPreparedExecutableWindow: prepared,
  });
  assert.equal(decision.kind, "expand_range");
});
