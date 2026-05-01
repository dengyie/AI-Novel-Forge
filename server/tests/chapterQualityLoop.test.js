const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChapterQualityLoopAssessment,
} = require("../../shared/dist/types/chapterQualityLoop.js");

function score(overrides = {}) {
  return {
    coherence: 88,
    repetition: 8,
    pacing: 86,
    voice: 85,
    engagement: 88,
    overall: 87,
    ...overrides,
  };
}

test("buildChapterQualityLoopAssessment continues when quality signals are valid", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-1",
    chapterOrder: 1,
    score: score(),
    issues: [],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(assessment.overallStatus, "valid");
  assert.equal(assessment.recommendedAction, "continue");
  assert.equal(assessment.patchFirstRequired, false);
  assert.equal(assessment.recheckRequired, false);
  assert.equal(assessment.signals.length, 3);
});

test("buildChapterQualityLoopAssessment requires patch-first repair for local quality risk", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-2",
    chapterOrder: 2,
    score: score({ engagement: 68, overall: 70 }),
    issues: [{
      severity: "high",
      category: "pacing",
      evidence: "结尾缺少推进和拉力。",
      fixSuggestion: "补强结尾钩子。",
    }],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(assessment.overallStatus, "risk");
  assert.equal(assessment.recommendedAction, "patch_repair");
  assert.equal(assessment.patchFirstRequired, true);
  assert.equal(assessment.recheckRequired, true);
});

test("buildChapterQualityLoopAssessment routes rolling window failures to replan", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-3",
    chapterOrder: 3,
    score: score(),
    issues: [],
    runtimePackage: {
      context: {
        chapter: { order: 3 },
      },
      audit: {
        reports: [],
        openIssues: [],
      },
      replanRecommendation: {
        recommended: true,
        reason: "连续三章推进偏离主线。",
        blockingIssueIds: ["issue-1"],
        blockingLedgerKeys: [],
        affectedChapterOrders: [3, 4],
      },
    },
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(assessment.overallStatus, "invalid");
  assert.equal(assessment.recommendedAction, "replan");
  assert.equal(assessment.patchFirstRequired, false);
  assert.equal(assessment.recheckRequired, true);
  assert.equal(
    assessment.signals.find((signal) => signal.artifactType === "rolling_window_review").status,
    "invalid",
  );
});
