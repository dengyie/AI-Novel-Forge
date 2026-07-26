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

test("decideRepairContentAdoption default overallDelta=1 tolerates 1-point noise", () => {
  // #15：LLM 评分 1 分抖动不应 anti-regression；默认 overallDelta=1
  const noise = decideRepairContentAdoption({
    baselineScore: score({ overall: 88, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 87, coherence: 72, repetition: 71, engagement: 71 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
  });
  assert.equal(noise.decision, "adopt");

  const realDrop = decideRepairContentAdoption({
    baselineScore: score({ overall: 88, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 86, coherence: 70, repetition: 70, engagement: 70 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
  });
  assert.equal(realDrop.decision, "discard");
  assert.match(realDrop.reason, /anti-regression|降至/);
});

test("decideRepairContentAdoption default plateauMax=3 needs three consecutive no-improve", () => {
  // #15：旧默认 2 过早 plateau；默认 3 需 consecutiveNoImprove=2 才 plateau_stop
  const second = decideRepairContentAdoption({
    baselineScore: score({ overall: 88 }),
    candidateScore: score({ overall: 80 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    consecutiveNoImprove: 1,
  });
  assert.equal(second.decision, "discard");

  const third = decideRepairContentAdoption({
    baselineScore: score({ overall: 88 }),
    candidateScore: score({ overall: 80 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    consecutiveNoImprove: 2,
  });
  assert.equal(third.decision, "plateau_stop");
  assert.match(third.reason, /连续无改进/);
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

test("decideRepairContentAdoption discards candidate that introduces prose_system_hud", () => {
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 95, coherence: 95, repetition: 95, engagement: 95 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: ["prose_system_hud"],
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /prose_system_hud/);
  assert.deepEqual(result.introducedBlockingCodes, ["prose_system_hud"]);
});

test("decideRepairContentAdoption discards when baseline L1 count grows, overall flat, no improvement", () => {
  const {
    fingerprintReviewIssuesAsL1BlockingCodes,
  } = require("@ai-novel/shared/types/repairAdoptDecision");
  // baseline 已有 1 个 L1（coherence），候选类目膨胀 1->2 引入 logic 新类，
  // 且 overall 未升、未过文学门、无门槛维提升 → 仍判回归（保留 anti-regression 兜底）。
  const baselineL1 = fingerprintReviewIssuesAsL1BlockingCodes([
    { severity: "high", category: "coherence", evidence: "义务A未兑现" },
  ]);
  const candidateL1 = fingerprintReviewIssuesAsL1BlockingCodes([
    { severity: "high", category: "coherence", evidence: "义务A未兑现（措辞抖动版）" },
    { severity: "critical", category: "logic", evidence: "义务B新增缺口" },
  ]);
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    baselineBlockingL1Codes: baselineL1,
    candidateBlockingL1Codes: candidateL1,
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /L1|类目膨胀/);
  assert.ok(result.introducedBlockingL1Codes.length >= 1);
});

test("decideRepairContentAdoption adopts when new L1 category appears but overall rises substantially", () => {
  const {
    fingerprintReviewIssuesAsL1BlockingCodes,
  } = require("@ai-novel/shared/types/repairAdoptDecision");
  // baseline 已有 L1，候选引入新类目 logic，但 overall 大幅上升 → 不应被一条新类硬否决（Part D 修正语义）。
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
  assert.equal(result.decision, "adopt");
  assert.ok(result.introducedBlockingL1Codes.length >= 1);
});

test("decideRepairContentAdoption discards new L1 from zero baseline when scores flat (I4)", () => {
  const {
    fingerprintReviewIssuesAsL1BlockingCodes,
  } = require("@ai-novel/shared/types/repairAdoptDecision");
  // I4：baseline 无 L1 不再单独走「新增任一类目即硬拒」——但真回归（类目 0→1 且分数毫无长进、
  // 未过文学门、无门槛维改进）依然必须挡住。
  const candidateL1 = fingerprintReviewIssuesAsL1BlockingCodes([
    { severity: "critical", category: "logic", evidence: "义务B新增缺口" },
  ]);
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    baselineBlockingL1Codes: [],
    candidateBlockingL1Codes: candidateL1,
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /L1/);
  assert.ok(result.introducedBlockingL1Codes.length >= 1);
});

test("decideRepairContentAdoption adopts new L1 from zero baseline when overall rises (I4)", () => {
  const {
    fingerprintReviewIssuesAsL1BlockingCodes,
  } = require("@ai-novel/shared/types/repairAdoptDecision");
  // I4 核心修复：baselineBlockingL1Codes 与 candidateBlockingL1Codes 来自两次独立的
  // evaluateOnly LLM 采样，codeless 指纹取值域只有 6 个 category —— baseline 恰好采样到 0 个
  // high/critical、candidate 采样到 1 个，属于常态抖动。旧实现在这种情况下硬 discard，
  // 而 repair_discarded 是终态，等于一次噪声就永久判死本轮该章（真跑 ch2 即此形态）。
  // 现在与 baseline 有硬伤时同一判据：分数明显改进即可采纳。
  const candidateL1 = fingerprintReviewIssuesAsL1BlockingCodes([
    { severity: "critical", category: "logic", evidence: "抖动出现的 logic 类目" },
  ]);
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 92, coherence: 92, repetition: 92, engagement: 92 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    baselineBlockingL1Codes: [],
    candidateBlockingL1Codes: candidateL1,
  });
  assert.equal(result.decision, "adopt");
  assert.ok(result.introducedBlockingL1Codes.length >= 1);
});

test("decideRepairContentAdoption still hard-discards new L0 from zero baseline (I4 不削弱 L0)", () => {
  // L0 安全网与 L1 判定完全独立：即使分数大幅上升，新引入 L0 硬伤一律 discard。
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 95, coherence: 95, repetition: 95, engagement: 95 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: ["prose_ai_self_reference"],
    baselineBlockingL1Codes: [],
    candidateBlockingL1Codes: [],
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /L0/);
});

test("decideRepairContentAdoption: skipL1Check 不绕过 L0（I4 回归防护）", () => {
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 70 }),
    candidateScore: score({ overall: 95 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: ["sot_timeline_conflict"],
    skipL1Check: true,
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /L0/);
});

test("decideRepairContentAdoption: skipScoreCheck 跳过假 20 anti-regression（C4）", () => {
  // 真跑 ch2/ch8：candidate overall 恰好 20（normalizeScore 缺项），baseline 81/88
  // → 旧逻辑 anti-regression 终态 discard。skipScoreCheck 后应 adopt（L0 干净）。
  const silent20 = score({
    coherence: 0,
    repetition: 100,
    pacing: 0,
    voice: 0,
    engagement: 0,
    overall: 20,
  });
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 81, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: silent20,
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    skipScoreCheck: true,
  });
  assert.equal(result.decision, "adopt");
  assert.match(result.reason, /score 降级|跳过分数/);
});

test("decideRepairContentAdoption: skipScoreCheck 不绕过 L0（C4 安全网）", () => {
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 81 }),
    candidateScore: score({ overall: 20, coherence: 0, repetition: 100, pacing: 0, voice: 0, engagement: 0 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: ["prose_verbatim_repeat"],
    skipScoreCheck: true,
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /L0|prose_verbatim_repeat/);
});

test("decideRepairContentAdoption: skipScoreCheck 仍受 L1 类目膨胀约束（除非 skipL1Check）", () => {
  // 候选 score 降级但 issues 仍可信时，L1 膨胀 + 无分数协议 → 仍应能用 L1 判据
  // （实际 runtime 在 candidate degraded 时同时 skipL1Check；本测锁纯函数组合语义）
  // baseline 门槛维已 ≥ 阈值，避免 L1 分支的 improvedDimension 逃生口放行。
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 88, coherence: 85, repetition: 85, engagement: 85 }),
    candidateScore: score({
      overall: 20,
      coherence: 0,
      repetition: 100,
      pacing: 0,
      voice: 0,
      engagement: 0,
    }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    baselineBlockingL1Codes: [],
    candidateBlockingL1Codes: ["l1:coherence", "l1:logic"],
    skipScoreCheck: true,
    // 不 skipL1：类目 0→2 且 overall 未升且未 isPass → 仍 fail
  });
  assert.equal(result.decision, "discard");
  assert.match(result.reason, /L1/);
});

test("decideRepairContentAdoption: runtime C4 组合 skipScoreCheck+skipL1Check 可采纳", () => {
  // ChapterRepairStreamRuntime：candidateScoreDegraded → 两旗同开；L0 干净则 adopt
  const result = decideRepairContentAdoption({
    baselineScore: score({ overall: 88, coherence: 80, repetition: 80, engagement: 80 }),
    candidateScore: score({
      overall: 20,
      coherence: 0,
      repetition: 100,
      pacing: 0,
      voice: 0,
      engagement: 0,
    }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
    baselineBlockingL1Codes: [],
    candidateBlockingL1Codes: ["l1:logic"], // 会被 skipL1 忽略
    skipScoreCheck: true,
    skipL1Check: true,
  });
  assert.equal(result.decision, "adopt");
  assert.match(result.reason, /score 降级|跳过分数/);
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

test("countTrailingRepairNoImprove ignores non-repair_adopt noise lines", () => {
  const history = [
    "[repair_adopt t1] decision=discard overall=80->78 reason=drop",
    "quality_loop: patch_repair recommended",
    "[quality_loop] something else decision=discard",
    "[repair_adopt t2] decision=discard overall=80->77 reason=drop2",
  ].join("\n");
  assert.equal(countTrailingRepairNoImprove(history), 2);
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
