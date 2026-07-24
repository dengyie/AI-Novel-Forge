const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countHardDebtFromQualityLoop,
  countHardDebtFromReviewIssues,
  synthesizeSignalsFromEvaluateOnly,
} = require("../dist/services/novel/volume/volumeReadinessSignals.js");

test("countHardDebtFromQualityLoop uses non-deferrable codes + invalid prose", () => {
  assert.equal(countHardDebtFromQualityLoop(null), 0);
  assert.equal(countHardDebtFromQualityLoop({
    signals: [{
      artifactType: "prose_quality",
      status: "risk",
      issueCodes: ["prose_pad_phrase"],
    }],
  }), 0);
  const withInvalid = countHardDebtFromQualityLoop({
    signals: [{
      artifactType: "prose_quality",
      status: "invalid",
      issueCodes: ["prose_verbatim_repeat", "prose_ai_self_reference"],
    }],
  });
  assert.ok(withInvalid >= 2);
});

test("countHardDebtFromReviewIssues counts non-deferrable issue codes", () => {
  assert.equal(countHardDebtFromReviewIssues([
    { code: "prose_ai_self_reference" },
    { code: "style_fluff" },
  ]), 1);
});

test("synthesizeSignalsFromEvaluateOnly keeps hasTrueReview from base (evaluateOnly 不落 artifact)", () => {
  const base = {
    chapterId: "c1",
    chapterOrder: 5,
    title: "t",
    chapterStatus: "pending_review",
    generationState: "approved",
    literaryPass: null,
    l0Clear: null,
    styleClear: null,
    hardDebtCount: 0,
    padHitCount: 0,
    hasTrueReview: false,
    contentEmpty: false,
  };
  const next = synthesizeSignalsFromEvaluateOnly({
    base,
    content: "他走进房间，把门关上。窗外有风。".repeat(20),
    review: {
      score: { coherence: 90, repetition: 90, engagement: 90, pacing: 80, voice: 80, overall: 88 },
      issues: [],
    },
  });
  // evaluateOnly 不写 literary_score/style_residual → 不得伪造真 review
  assert.equal(next.hasTrueReview, false);
  assert.equal(next.literaryPass, true);
  assert.equal(typeof next.styleClear, "boolean");
  assert.equal(typeof next.l0Clear, "boolean");
  assert.ok(next.lastReviewedAt);

  const alreadyTrue = synthesizeSignalsFromEvaluateOnly({
    base: { ...base, hasTrueReview: true },
    content: "他走进房间，把门关上。窗外有风。".repeat(20),
    review: {
      score: { coherence: 90, repetition: 90, engagement: 90, pacing: 80, voice: 80, overall: 88 },
      issues: [],
    },
  });
  assert.equal(alreadyTrue.hasTrueReview, true);
});
