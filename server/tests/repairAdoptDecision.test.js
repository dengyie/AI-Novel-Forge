const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appendRepairAdoptHistoryLine,
  countTrailingRepairNoImprove,
  decideRepairContentAdoption,
  formatRepairAdoptHistoryLine,
} = require("@ai-novel/shared/types/repairAdoptDecision");
const {
  DEFAULT_QUALITY_IS_PASS_THRESHOLD,
  isLiteraryQualityPass,
} = require("@ai-novel/shared/types/literaryQualityPass");

function score(partial = {}) {
  return {
    coherence: 90,
    repetition: 90,
    pacing: 90,
    voice: 90,
    engagement: 90,
    overall: 90,
    ...partial,
  };
}

test("isLiteraryQualityPass uses frozen thresholds", () => {
  assert.equal(DEFAULT_QUALITY_IS_PASS_THRESHOLD.coherence, 80);
  assert.equal(DEFAULT_QUALITY_IS_PASS_THRESHOLD.repetition, 75);
  assert.equal(DEFAULT_QUALITY_IS_PASS_THRESHOLD.engagement, 75);
  assert.equal(isLiteraryQualityPass(score({ coherence: 80, repetition: 75, engagement: 75 })), true);
  assert.equal(isLiteraryQualityPass(score({ coherence: 79, repetition: 90, engagement: 90 })), false);
});

test("decideRepairContentAdoption adopts when candidate improves without L0 regression", () => {
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 85, coherence: 85, repetition: 85, engagement: 85 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
  });
  assert.equal(result.decision, "adopt");
  assert.equal(result.candidateLiteraryPass, true);
  assert.equal(result.scoreDelta.overall, 15);
});

test("decideRepairContentAdoption discards overall regression", () => {
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 88 }),
    candidateScore: score({ overall: 80, coherence: 90, repetition: 90, engagement: 90 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /anti-regression|降至/);
});

test("decideRepairContentAdoption discards newly introduced L0 codes", () => {
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70 }),
    candidateScore: score({ overall: 90 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: ["prose_ai_self_reference"],
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /prose_ai_self_reference/);
  assert.deepEqual(result.introducedBlockingCodes, ["prose_ai_self_reference"]);
});

test("decideRepairContentAdoption discards newly introduced L1 blocking codes", () => {
  const {
    fingerprintReviewIssuesAsL1BlockingCodes,
  } = require("@ai-novel/shared/types/repairAdoptDecision");
  const baselineL1 = fingerprintReviewIssuesAsL1BlockingCodes([
    { severity: "high", category: "coherence", evidence: "义务A未兑现" },
  ]);
  const candidateL1 = fingerprintReviewIssuesAsL1BlockingCodes([
    { severity: "high", category: "coherence", evidence: "义务A未兑现" },
    { severity: "critical", category: "logic", evidence: "义务B新增缺口" },
  ]);
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 92, coherence: 92, repetition: 92, engagement: 92 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    baselineBlockingL1Codes: baselineL1,
    candidateBlockingL1Codes: candidateL1,
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /L1/);
  assert.ok(result.introducedBlockingL1Codes.length >= 1);
});

test("decideRepairContentAdoption plateau_stop after consecutive no-improve", () => {
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 88 }),
    candidateScore: score({ overall: 80 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    consecutiveNoImprove: 1,
    plateauMaxNoImprove: 2,
  });
  assert.equal(result.decision, "plateau_stop");
  assert.match(result.reason, /连续无改进/);
});

test("decideRepairContentAdoption rejects losing literary pass", () => {
  const result = decideRepairContentAdoption({
    baselineScore: score({ coherence: 85, repetition: 85, engagement: 85, overall: 85 }),
    candidateScore: score({ coherence: 70, repetition: 85, engagement: 85, overall: 85 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /基线已 isPass/);
});

test("countTrailingRepairNoImprove counts discard/plateau lines", () => {
  const history = [
    "[repair_adopt t1] decision=adopt overall=70->80 reason=ok",
    "[repair_adopt t2] decision=discard overall=80->78 reason=drop",
    "[repair_adopt t3] decision=plateau_stop overall=80->78 reason=stop",
  ].join("\n");
  assert.equal(countTrailingRepairNoImprove(history), 2);
  assert.equal(countTrailingRepairNoImprove(""), 0);
});

test("format and append repair adopt history lines", () => {
  const line = formatRepairAdoptHistoryLine({
    decision: "discard",
    reason: "overall drop",
    baselineOverall: 90,
    candidateOverall: 80,
    baselineHash: "abcdef1234567890",
    candidateHash: "fedcba0987654321",
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });
  assert.match(line, /decision=discard/);
  assert.match(line, /overall=90->80/);
  assert.match(line, /base=abcdef123456/);
  const next = appendRepairAdoptHistoryLine("old line\n", line, 2);
  assert.equal(next.split("\n").length, 2);
  assert.match(next, /decision=discard/);
});
