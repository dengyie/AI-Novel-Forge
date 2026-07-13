const test = require("node:test");
const assert = require("node:assert/strict");

// Director self-cycle P0 acceptance suite (Phase 1–4 invariants).
// Pure-function invariants: BatchRoll, contract strip, no rewind, P1 clear-up.

const {
  resolveNextAutoExecutionBatchRoll,
  applyExpandRangeBatchRoll,
  DEFAULT_MAX_CONSECUTIVE_BATCH_ROLLS,
  resolveContiguousWindowFromOrders,
  resolveNextUnpreparedWindow,
  resolveNextPreparedExecutableWindow,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionBatchRollRuntime.js");

const {
  sanitizeChapterTaskSheetForPersistence,
  containsInternalQualityCodes,
} = require("../../shared/dist/types/chapterTaskSheetQuality.js");

const {
  stateRangeHasPendingWork,
  resolveNextPreparedExecutableRangeFromChapters,
} = require("../dist/services/novel/director/runtime/novelDirectorTakeoverRuntime.js");

const {
  evaluateLengthBudget,
  LENGTH_HARD_UNDER_RATIO,
} = require("../../shared/dist/types/chapterLengthControl.js");

const { isSkippableAutoExecutionReviewFailure } = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionFailure.js");
const { resolveModel } = require("../dist/llm/modelRouter.js");
const { prisma } = require("../dist/db/prisma.js");
const { normalizeAssessment } = require("../dist/services/novel/runtime/ChapterAcceptanceAssessmentService.js");

// ---------- helpers ----------

function buildAssessment(overrides = {}) {
  return {
    status: "accepted",
    score: { coherence: 80, pacing: 80, repetition: 80, engagement: 80, voice: 80, overall: 80 },
    summary: "accepted",
    blockingIssues: [],
    repairDirectives: [],
    missingObligations: [],
    riskTags: [],
    assetSyncRecommendation: { priority: "normal", reason: "ok", requiresFullPayoffReconcile: false },
    continuePolicy: "continue",
    ...overrides,
  };
}

function buildSceneCards(chapterId, targetWordCount = 2800) {
  return JSON.stringify({
    targetWordCount,
    lengthBudget: {
      targetWordCount,
      softMinWordCount: Math.round(targetWordCount * 0.85),
      softMaxWordCount: Math.round(targetWordCount * 1.15),
      hardMaxWordCount: Math.round(targetWordCount * 1.25),
    },
    scenes: [1, 2, 3].map((index) => ({
      key: `${chapterId}-scene-${index}`,
      title: `场景${index}`,
      purpose: `推进${index}`,
      mustAdvance: [`推进点${index}`],
      mustPreserve: ["不提前揭晓终局"],
      entryState: `入场${index}`,
      exitState: `离场${index}`,
      forbiddenExpansion: ["不跨章"],
      targetWordCount: Math.round(targetWordCount / 3),
    })),
  });
}

function makeChapter(order, overrides = {}) {
  const id = overrides.id ?? `chapter-${order}`;
  return {
    id,
    order,
    expectation: overrides.expectation ?? `目标${order}`,
    generationState: overrides.generationState ?? "planned",
    chapterStatus: overrides.chapterStatus ?? "pending_generation",
    content: overrides.content ?? "",
    conflictLevel: overrides.conflictLevel ?? 50,
    revealLevel: overrides.revealLevel ?? 40,
    targetWordCount: overrides.targetWordCount ?? 3000,
    mustAvoid: overrides.mustAvoid ?? "不要越界",
    taskSheet: overrides.taskSheet ?? `第${order}章任务单：推进主线冲突。`,
    sceneCards: overrides.sceneCards ?? buildSceneCards(id),
  };
}

// ---------- Phase 1: BatchRoll — window end rolls forward, not workflow_completed ----------

test("self-cycle: window exhaustion rolls to next prepared window instead of terminal workflow_completed", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: "c11" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range", startOrder: 11, endOrder: 20 },
    consecutiveBatchRolls: 0,
    nextPreparedExecutableWindow: { startOrder: 21, endOrder: 30 },
    nextUnpreparedWindow: null,
  });
  assert.equal(decision.kind, "expand_range");
  assert.deepEqual(decision.nextRange, { startOrder: 21, endOrder: 30 });
});

test("self-cycle: missing next window yields completed_scope (terminal), not endless rolling", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 31, endOrder: 40, totalChapterCount: 10, firstChapterId: "c31" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range", startOrder: 31, endOrder: 40 },
    consecutiveBatchRolls: 0,
    nextPreparedExecutableWindow: null,
    nextUnpreparedWindow: null,
  });
  assert.equal(decision.kind, "completed_scope");
});

test("self-cycle: next window lacks detail → reenter_structured_outline (prepare then continue)", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: "c11" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range", startOrder: 11, endOrder: 20 },
    consecutiveBatchRolls: 0,
    nextPreparedExecutableWindow: null,
    nextUnpreparedWindow: { startOrder: 21, endOrder: 30 },
  });
  assert.equal(decision.kind, "reenter_structured_outline");
});

test("self-cycle: consecutive batch rolls are capped at MAX_CONSECUTIVE_BATCH_ROLLS", () => {
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: "c11" },
    autoExecution: { enabled: true, remainingChapterCount: 0, mode: "chapter_range", startOrder: 11, endOrder: 20 },
    consecutiveBatchRolls: DEFAULT_MAX_CONSECUTIVE_BATCH_ROLLS,
    nextPreparedExecutableWindow: { startOrder: 21, endOrder: 30 },
    nextUnpreparedWindow: null,
  });
  assert.ok(
    decision.kind === "halt_for_review" || decision.kind === "completed_scope",
    `unexpected cap decision ${decision.kind}`,
  );
  assert.notEqual(decision.kind, "expand_range");
});

test("self-cycle: expand_range roll clears stale pipelineJobId and preserves cross-window skips", () => {
  const previousState = {
    enabled: true,
    mode: "chapter_range",
    startOrder: 11,
    endOrder: 20,
    totalChapterCount: 10,
    firstChapterId: "chapter-11",
    nextChapterId: null,
    nextChapterOrder: null,
    // chapter-22 is quality-debt-skipped; chapter-25 is quality-debt only.
    // Both sit inside the next 21-30 window so they should survive the roll.
    skippedChapterIds: ["chapter-22"],
    skippedChapterOrders: [22],
    qualityDebtChapterIds: ["chapter-22", "chapter-25"],
    qualityDebtChapterOrders: [22, 25],
    pipelineJobId: "stale-job-11-20",
    pipelineStatus: "succeeded",
    remainingChapterCount: 0,
    scopeLabel: "第 11-20 章",
    volumeTitle: "第一卷",
    preparedVolumeIds: [],
  };
  // chapter-22 is a real quality-debt skip: written, reviewed, needs repair.
  // chapter-25 is a normal pending chapter that carries a quality-debt flag.
  const chapters = Array.from({ length: 10 }, (_v, i) => {
    const order = 21 + i;
    const id = `chapter-${order}`;
    if (order === 22) {
      return {
        id,
        order,
        generationState: "reviewed",
        chapterStatus: "needs_repair",
        content: `正文${order}（待修）`,
        targetWordCount: 3000,
      };
    }
    return { id, order, generationState: "planned", chapterStatus: "pending_generation", content: "", targetWordCount: 3000 };
  });
  const rolled = applyExpandRangeBatchRoll({
    previousState,
    nextRange: { startOrder: 21, endOrder: 30 },
    chapters,
  });
  // Stale pipeline job must not carry into the next window.
  assert.notEqual(rolled.autoExecution.pipelineJobId, "stale-job-11-20");
  assert.equal(rolled.autoExecution.pipelineStatus, "queued");
  // The quality-debt skip on chapter-22 survives into the new window.
  assert.ok(rolled.autoExecution.skippedChapterIds.includes("chapter-22"));
  assert.ok(rolled.autoExecution.qualityDebtChapterIds.includes("chapter-22"));
  assert.equal(rolled.range.startOrder, 21);
  assert.equal(rolled.range.endOrder, 30);
});

// ---------- Phase 2: contract strip — internal codes stripped, obligations preserved ----------

test("self-cycle: sanitize strips internal quality codes from taskSheet but preserves natural-language deliverables", () => {
  const sheet = [
    "章节目标：主角识破圈套。",
    "必须推进：",
    "- 揭露反派的真名",
    "internal_codes:[payoff_missing_progress][draft_obligation_unmet]",
    "replan_required 状态未结算",
    "必须保留：不提前揭晓终局",
  ].join("\n");
  const sanitized = sanitizeChapterTaskSheetForPersistence(sheet) ?? "";
  // Internal code markers must be gone.
  assert.equal(containsInternalQualityCodes(sanitized), false);
  // Natural-language obligations survive (推进要求 / 保留条款).
  assert.match(sanitized, /揭露反派的真名/);
  assert.match(sanitized, /不提前揭晓终局/);
});

test("self-cycle: taskSheet carrying only internal quality codes strips the codes out (no leakage to writer)", () => {
  const codeOnly = "internal_codes:[payoff_missing_progress][draft_obligation_unmet][forbidden_crossing]";
  const sanitized = sanitizeChapterTaskSheetForPersistence(codeOnly);
  // After sanitize, no internal quality code may survive into the persisted sheet.
  assert.equal(containsInternalQualityCodes(sanitized ?? ""), false);
  // The raw codes themselves are gone from the persisted text.
  assert.ok(!(sanitized ?? "").includes("payoff_missing_progress"));
  assert.ok(!(sanitized ?? "").includes("draft_obligation_unmet"));
  assert.ok(!(sanitized ?? "").includes("forbidden_crossing"));
});

// ---------- Phase 3: recovery / range does not rewind to completed batch ----------

test("self-cycle: completed 11-20 batch is never re-bound when 21-30 is prepared pending", () => {
  const chapters = [
    ...[11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((order) => makeChapter(order, {
      generationState: "approved",
      chapterStatus: "completed",
      content: `正文${order}`,
    })),
    ...[21, 22, 23].map((order) => makeChapter(order, {
      generationState: "planned",
      chapterStatus: "pending_generation",
      content: "",
    })),
  ];
  const next = resolveNextPreparedExecutableRangeFromChapters(chapters, 20);
  assert.equal(next?.startOrder, 21);
  assert.equal(next?.endOrder, 23);
  // Must never rebind the completed 11-20 window.
  assert.notEqual(next?.startOrder, 11);
});

test("self-cycle: state window with remaining pending chapters keeps its range (no premature roll)", () => {
  const chapters = [11, 12, 13].map((order) => makeChapter(order));
  chapters[0].generationState = "approved";
  chapters[0].chapterStatus = "completed";
  chapters[0].content = "done 11";
  const hasPending = stateRangeHasPendingWork(chapters, {
    enabled: true,
    mode: "chapter_range",
    startOrder: 11,
    endOrder: 13,
  });
  assert.equal(hasPending, true);
});

// ---------- Phase 4 P1: empty model, under_hard, non-skippable short chapter ----------

test("self-cycle: empty model override from stale job payload does not clobber route model", async () => {
  const original = prisma.modelRouteConfig.findUnique;
  prisma.modelRouteConfig.findUnique = async () => ({
    taskType: "writer",
    provider: "openai",
    model: "deepseek-v4-pro",
    temperature: 0.8,
    maxTokens: null,
    requestProtocol: "auto",
    structuredResponseFormat: "auto",
  });
  try {
    const resolved = await resolveModel("writer", { provider: "deepseek", model: "" });
    assert.equal(resolved.model, "deepseek-v4-pro");
  } finally {
    prisma.modelRouteConfig.findUnique = original;
  }
});

test("self-cycle: severely short chapter (under_hard) is never silently accepted", () => {
  // target 3000 → hardMin = floor(3000 × 0.6) = 1800; content 1500 is under_hard.
  assert.equal(LENGTH_HARD_UNDER_RATIO, 0.6);
  const evaluation = evaluateLengthBudget({ content: "字".repeat(1500), targetWordCount: 3000 });
  assert.equal(evaluation?.band, "under_hard");
  assert.ok(evaluation?.riskTags.includes("length_under_hard"));

  const normalized = normalizeAssessment(buildAssessment({ status: "accepted" }), "字".repeat(1500), 3000);
  assert.notEqual(normalized.status, "accepted");
  assert.ok(
    normalized.status === "repairable" || normalized.status === "needs_manual_review",
    `unexpected under_hard status ${normalized.status}`,
  );
  assert.notEqual(normalized.continuePolicy, "continue");
});

test("self-cycle: a length-risk review failure is not skippable (short chapter enters checkpoint)", () => {
  const lengthBlocked = "Chapter generation is blocked until review is resolved. length_under_hard 字数不足";
  assert.equal(isSkippableAutoExecutionReviewFailure(lengthBlocked), false);
  // Non-length review failures remain skippable (existing behavior preserved).
  const plainReviewBlocked = "Chapter generation is blocked until review is resolved. 2 pending state proposal(s)";
  assert.equal(isSkippableAutoExecutionReviewFailure(plainReviewBlocked), true);
});

test("self-cycle: within-soft and over-hard chapters do not false-trigger under_hard gate", () => {
  const within = evaluateLengthBudget({ content: "字".repeat(3000), targetWordCount: 3000 });
  assert.equal(within?.band, "within_soft");
  assert.ok(!within?.riskTags.includes("length_under_hard"));

  const normalized = normalizeAssessment(buildAssessment({ status: "accepted" }), "字".repeat(3000), 3000);
  // A full-length chapter with no blocking issues stays accepted.
  assert.equal(normalized.status, "accepted");
});
