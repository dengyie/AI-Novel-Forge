const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_QUALITY_IS_PASS_THRESHOLD,
  isLiteraryQualityPass,
  projectLiteraryPassFromScore,
  projectLiteraryPassFromQualityLoopSignals,
  projectLiteraryPassFromRiskFlags,
} = require("../../shared/dist/types/literaryQualityPass.js");

test("DEFAULT_QUALITY_IS_PASS_THRESHOLD freezes literary floors 80/75/75", () => {
  assert.deepEqual(DEFAULT_QUALITY_IS_PASS_THRESHOLD, {
    coherence: 80,
    repetition: 75,
    engagement: 75,
  });
});

test("isLiteraryQualityPass ignores overall and requires all three literary dims", () => {
  assert.equal(isLiteraryQualityPass({
    coherence: 80,
    repetition: 75,
    engagement: 75,
  }), true);
  assert.equal(isLiteraryQualityPass({
    coherence: 79,
    repetition: 90,
    engagement: 90,
  }), false);
  assert.equal(isLiteraryQualityPass({
    coherence: 90,
    repetition: 74,
    engagement: 90,
  }), false);
  assert.equal(isLiteraryQualityPass({
    coherence: 90,
    repetition: 90,
    engagement: 74,
  }), false);
});

test("projectLiteraryPassFromScore returns null when any literary dim missing", () => {
  assert.equal(projectLiteraryPassFromScore(null), null);
  assert.equal(projectLiteraryPassFromScore({ coherence: 80, repetition: 75 }), null);
  assert.equal(projectLiteraryPassFromScore({
    coherence: 88,
    repetition: 88,
    engagement: 88,
  }), true);
});

test("projectLiteraryPassFromQualityLoopSignals uses literary_score status", () => {
  assert.equal(projectLiteraryPassFromQualityLoopSignals(null), null);
  assert.equal(projectLiteraryPassFromQualityLoopSignals([
    { artifactType: "prose_quality", status: "risk" },
  ]), null);
  assert.equal(projectLiteraryPassFromQualityLoopSignals([
    { artifactType: "literary_score", status: "valid" },
  ]), true);
  assert.equal(projectLiteraryPassFromQualityLoopSignals([
    { artifactType: "literary_score", status: "risk" },
  ]), false);
});

test("projectLiteraryPassFromRiskFlags reads qualityLoop.signals", () => {
  assert.equal(projectLiteraryPassFromRiskFlags(null), null);
  assert.equal(projectLiteraryPassFromRiskFlags("{"), null);
  assert.equal(projectLiteraryPassFromRiskFlags(JSON.stringify({
    qualityLoop: {
      signals: [{ artifactType: "literary_score", status: "valid" }],
    },
  })), true);
  assert.equal(projectLiteraryPassFromRiskFlags(JSON.stringify({
    qualityLoop: {
      signals: [{ artifactType: "literary_score", status: "invalid" }],
    },
  })), false);
});
