const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isDirectorAutoExecutionChapterProcessed,
  hasBlockingQualityLoopDebtForAutoExecution,
  buildDirectorAutoExecutionState,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecution.js");

function chapter(overrides = {}) {
  return {
    id: "ch-1",
    order: 1,
    content: "正文",
    generationState: "reviewed",
    chapterStatus: "pending_review",
    ...overrides,
  };
}

test("reviewed pending_review without riskFlags stays processed (compat)", () => {
  const row = chapter();
  delete row.riskFlags;
  assert.equal(isDirectorAutoExecutionChapterProcessed(row), true);
});

test("blocking replan quality debt is not processed even if reviewed", () => {
  const row = chapter({
    riskFlags: JSON.stringify({
      qualityLoop: {
        overallStatus: "invalid",
        recommendedAction: "replan",
        rootCauseCode: "replan_required",
        terminalAction: "defer_and_continue",
      },
    }),
  });
  assert.equal(hasBlockingQualityLoopDebtForAutoExecution(row), true);
  assert.equal(isDirectorAutoExecutionChapterProcessed(row), false);
});

test("non-blocking deferred patch debt remains processable for advance", () => {
  const row = chapter({
    riskFlags: JSON.stringify({
      qualityLoop: {
        overallStatus: "risk",
        recommendedAction: "patch_repair",
        rootCauseCode: "draft_repair_exhausted",
        terminalAction: "defer_and_continue",
      },
    }),
  });
  assert.equal(hasBlockingQualityLoopDebtForAutoExecution(row), false);
  assert.equal(isDirectorAutoExecutionChapterProcessed(row), true);
});

test("buildDirectorAutoExecutionState keeps blocking replan chapter in remaining", () => {
  const state = buildDirectorAutoExecutionState({
    range: { startOrder: 1, endOrder: 2, totalChapterCount: 2, firstChapterId: "a" },
    chapters: [
      chapter({
        id: "a",
        order: 1,
        riskFlags: JSON.stringify({
          qualityLoop: {
            overallStatus: "invalid",
            recommendedAction: "replan",
            rootCauseCode: "replan_required",
          },
        }),
      }),
      chapter({
        id: "b",
        order: 2,
        generationState: "planned",
        chapterStatus: "pending_generation",
        content: "",
      }),
    ],
  });
  assert.equal(state.nextChapterId, "a");
  assert.ok(state.remainingChapterIds.includes("a"));
});
