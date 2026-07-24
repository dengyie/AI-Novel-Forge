const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyChapterReadiness,
  summarizeReadinessPlans,
  filterPlansByAction,
  DEFAULT_VOLUME_READINESS_THRESHOLDS,
} = require("../dist/services/novel/volume/volumeReadinessPolicy.js");

function baseSignals(overrides = {}) {
  return {
    chapterId: "ch1",
    chapterOrder: 1,
    title: "开篇",
    chapterStatus: "pending_review",
    generationState: "approved",
    literaryPass: null,
    l0Clear: null,
    styleClear: null,
    hardDebtCount: 0,
    padHitCount: 0,
    hasTrueReview: false,
    contentEmpty: false,
    ...overrides,
  };
}

test("never-reviewed chapter with content → needs_re_review", () => {
  const plan = classifyChapterReadiness(baseSignals());
  assert.equal(plan.verdict, "needs_re_review");
});

test("empty content → needs_manual", () => {
  const plan = classifyChapterReadiness(baseSignals({ contentEmpty: true }));
  assert.equal(plan.verdict, "needs_manual");
});

test("literaryPass false → needs_heavy", () => {
  const plan = classifyChapterReadiness(baseSignals({
    hasTrueReview: true,
    literaryPass: false,
    l0Clear: true,
    styleClear: true,
  }));
  assert.equal(plan.verdict, "needs_heavy");
});

test("hard debt with true review → needs_heavy", () => {
  const plan = classifyChapterReadiness(baseSignals({
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: false,
    styleClear: true,
    hardDebtCount: 2,
  }));
  assert.equal(plan.verdict, "needs_heavy");
});

test("styleClear false → needs_patch", () => {
  const plan = classifyChapterReadiness(baseSignals({
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: true,
    styleClear: false,
  }));
  assert.equal(plan.verdict, "needs_patch");
});

test("l0Clear false without hard debt → needs_patch", () => {
  const plan = classifyChapterReadiness(baseSignals({
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: false,
    styleClear: true,
    hardDebtCount: 0,
  }));
  assert.equal(plan.verdict, "needs_patch");
});

test("pad soft threshold → needs_patch", () => {
  const thresholds = {
    ...DEFAULT_VOLUME_READINESS_THRESHOLDS,
    padSoftThreshold: 8,
    padHardThreshold: 20,
  };
  const plan = classifyChapterReadiness(baseSignals({
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: true,
    styleClear: true,
    padHitCount: 10,
  }), thresholds);
  assert.equal(plan.verdict, "needs_patch");
});

test("pad hard threshold → needs_patch", () => {
  const thresholds = {
    padSoftThreshold: 8,
    padHardThreshold: 20,
  };
  const plan = classifyChapterReadiness(baseSignals({
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: true,
    styleClear: true,
    padHitCount: 25,
  }), thresholds);
  assert.equal(plan.verdict, "needs_patch");
});

test("all green + completed + residual pad < soft → needs_patch (not polish)", () => {
  const plan = classifyChapterReadiness(baseSignals({
    chapterStatus: "completed",
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: true,
    styleClear: true,
    hardDebtCount: 0,
    padHitCount: 2,
  }), {
    padSoftThreshold: 8,
    padHardThreshold: 20,
  });
  assert.equal(plan.verdict, "needs_patch");
});

test("all green + completed + pad zero → publish_ready", () => {
  const plan = classifyChapterReadiness(baseSignals({
    chapterStatus: "completed",
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: true,
    styleClear: true,
    hardDebtCount: 0,
    padHitCount: 0,
  }), {
    padSoftThreshold: 8,
    padHardThreshold: 20,
  });
  assert.equal(plan.verdict, "publish_ready");
});

test("true review but not completed → needs_re_review to close dual gate", () => {
  const plan = classifyChapterReadiness(baseSignals({
    chapterStatus: "pending_review",
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: true,
    styleClear: true,
  }));
  assert.equal(plan.verdict, "needs_re_review");
});

test("summarize and filter plans", () => {
  const plans = [
    classifyChapterReadiness(baseSignals({ chapterId: "a", chapterOrder: 1 })),
    classifyChapterReadiness(baseSignals({
      chapterId: "b",
      chapterOrder: 2,
      hasTrueReview: true,
      literaryPass: false,
      l0Clear: true,
      styleClear: true,
    })),
    classifyChapterReadiness(baseSignals({
      chapterId: "c",
      chapterOrder: 3,
      chapterStatus: "completed",
      hasTrueReview: true,
      literaryPass: true,
      l0Clear: true,
      styleClear: true,
    })),
  ];
  const summary = summarizeReadinessPlans(plans);
  assert.equal(summary.total, 3);
  assert.equal(summary.needsReReview, 1);
  assert.equal(summary.needsHeavy, 1);
  assert.equal(summary.publishReady, 1);
  assert.equal(summary.needsPolish, 0);
  const actionable = filterPlansByAction(plans, ["needs_heavy"]);
  assert.equal(actionable.length, 1);
  assert.equal(actionable[0].chapterId, "b");
});

test("filterPlansByAction includes needs_polish when present", () => {
  const plans = [{
    chapterId: "p1",
    chapterOrder: 1,
    title: "润色",
    verdict: "needs_polish",
    reasons: ["style residual"],
    signals: baseSignals({ chapterId: "p1", chapterStatus: "completed" }),
  }];
  const filtered = filterPlansByAction(plans, ["needs_polish"]);
  assert.equal(filtered.length, 1);
  const summary = summarizeReadinessPlans(plans);
  assert.equal(summary.needsPolish, 1);
});

test("residual pad is needs_patch and not needs_polish", () => {
  const plan = classifyChapterReadiness(baseSignals({
    chapterId: "p2",
    chapterOrder: 2,
    chapterStatus: "completed",
    hasTrueReview: true,
    literaryPass: true,
    l0Clear: true,
    styleClear: true,
    padHitCount: 3,
  }), { padSoftThreshold: 8, padHardThreshold: 20 });
  assert.equal(plan.verdict, "needs_patch");
  assert.equal(filterPlansByAction([plan], ["needs_polish"]).length, 0);
  assert.equal(filterPlansByAction([plan], ["needs_patch"]).length, 1);
});
