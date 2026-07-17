const test = require("node:test");
const assert = require("node:assert/strict");

const {
  projectStyleClear,
  hasBlockingPronounProseFromIssueCodes,
  projectResidualRiskScore,
  DEFAULT_STYLE_GATE_MAX_ORDER,
  DEFAULT_RESIDUAL_RISK_HARD,
} = require("../../shared/dist/types/styleClearGate.js");
const {
  chapterStatePairAfterLiteraryQualityGate,
  chapterStatePairAfterQualityGates,
  mergeChapterPatchForGenerationStateBump,
} = require("../dist/services/novel/chapterLifecycleState.js");
const {
  buildChapterQualityLoopAssessment,
  projectStyleClearFromQualityLoop,
} = require("../../shared/dist/types/chapterQualityLoop.js");

test("defaults: styleGateMaxOrder=3 residualRiskHard=35", () => {
  assert.equal(DEFAULT_STYLE_GATE_MAX_ORDER, 3);
  assert.equal(DEFAULT_RESIDUAL_RISK_HARD, 35);
});

test("projectStyleClear false on opening chapter with residual risk 50", () => {
  assert.equal(
    projectStyleClear({
      residualRiskScore: 50,
      hasBlockingPronounProse: false,
      chapterOrder: 1,
    }),
    false,
  );
});

test("projectStyleClear false when blocking pronoun even mid-book", () => {
  assert.equal(
    projectStyleClear({
      residualRiskScore: 0,
      hasBlockingPronounProse: true,
      chapterOrder: 40,
    }),
    false,
  );
});

test("projectStyleClear true when mid-book residual only", () => {
  assert.equal(
    projectStyleClear({
      residualRiskScore: 50,
      hasBlockingPronounProse: false,
      chapterOrder: 40,
    }),
    true,
  );
});

test("projectStyleClear false on gated chapter when residual unknown (null)", () => {
  // 防 no-rewrite residual=null 假 true
  assert.equal(
    projectStyleClear({
      residualRiskScore: null,
      hasBlockingPronounProse: false,
      chapterOrder: 2,
    }),
    false,
  );
});

test("projectStyleClear true on opening when residual below hard", () => {
  assert.equal(
    projectStyleClear({
      residualRiskScore: 20,
      hasBlockingPronounProse: false,
      chapterOrder: 1,
    }),
    true,
  );
});

test("hasBlockingPronounProseFromIssueCodes：hard 码 true，soft 不算", () => {
  assert.equal(
    hasBlockingPronounProseFromIssueCodes(["prose_pronoun_subject_stack"]),
    true,
  );
  assert.equal(
    hasBlockingPronounProseFromIssueCodes(["prose_pronoun_density"]),
    true,
  );
  assert.equal(
    hasBlockingPronounProseFromIssueCodes(["prose_pronoun_density_soft"]),
    false,
  );
});

test("projectResidualRiskScore：优先 residualReport", () => {
  assert.equal(
    projectResidualRiskScore({
      residualReport: { riskScore: 12 },
      report: { riskScore: 80 },
    }),
    12,
  );
  assert.equal(
    projectResidualRiskScore({
      residualReport: null,
      report: { riskScore: 44 },
    }),
    44,
  );
  assert.equal(projectResidualRiskScore(null), null);
});

test("A-style: !styleClear cannot quality-over-approve completed on ch1", () => {
  // literaryPass true 但 styleClear false → 不得 completed
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: false }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", {
      literaryPass: true,
      styleClear: false,
    }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  // 双门皆过 → completed
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: true }),
    {
      generationState: "approved",
      chapterStatus: "completed",
    },
  );
  // 兼容：仅 literaryPass 布尔的旧 helper 语义不变（true→completed）
  assert.deepEqual(chapterStatePairAfterLiteraryQualityGate(true), {
    generationState: "approved",
    chapterStatus: "completed",
  });
  // fail-closed：styleClear 省略不得 completed
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", { literaryPass: true }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
});

test("qualityLoop：开篇 residual 高 → style_residual risk，styleClear 投影 false", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "ch-1",
    chapterOrder: 1,
    score: {
      coherence: 90,
      pacing: 90,
      repetition: 90,
      engagement: 90,
      voice: 90,
      overall: 90,
    },
    issues: [],
    runtimePackage: {
      context: { chapter: { order: 1 } },
      audit: { reports: [], openIssues: [] },
      failureClassification: {
        code: "none",
        summary: "",
        decisionReason: null,
        blockingObligations: [],
      },
      styleReview: {
        autoRewritten: false,
        report: {
          riskScore: 50,
          summary: "",
          canAutoRewrite: true,
          appliedRuleIds: [],
          violations: [],
        },
        residualReport: {
          riskScore: 50,
          summary: "",
          canAutoRewrite: true,
          appliedRuleIds: [],
          violations: [],
        },
      },
    },
  });
  const residualSignal = assessment.signals.find((s) => s.artifactType === "style_residual");
  assert.ok(residualSignal, "应有 style_residual signal");
  assert.equal(residualSignal.status, "risk");
  assert.equal(projectStyleClearFromQualityLoop(assessment), false);
  // 开篇 residual 债应抬 recommendedAction，不得 continue 过审
  assert.notEqual(assessment.recommendedAction, "continue");
});

test("qualityLoop：blocking pronoun → style_pronoun invalid", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "ch-40",
    chapterOrder: 40,
    score: {
      coherence: 90,
      pacing: 90,
      repetition: 90,
      engagement: 90,
      voice: 90,
      overall: 90,
    },
    issues: [],
    runtimePackage: {
      context: { chapter: { order: 40 } },
      audit: {
        reports: [],
        openIssues: [
          {
            auditType: "mode_fit",
            severity: "high",
            code: "prose_pronoun_subject_stack",
            evidence: "他坐下。他端杯。他没喝。他起身。",
            fixSuggestion: "改用专名起句",
          },
        ],
      },
      failureClassification: {
        code: "none",
        summary: "",
        decisionReason: null,
        blockingObligations: [],
      },
      styleReview: {
        autoRewritten: false,
        report: { riskScore: 10, summary: "", canAutoRewrite: false, appliedRuleIds: [], violations: [] },
        residualReport: { riskScore: 10, summary: "", canAutoRewrite: false, appliedRuleIds: [], violations: [] },
      },
    },
  });
  const pronounSignal = assessment.signals.find((s) => s.artifactType === "style_pronoun");
  assert.ok(pronounSignal);
  assert.equal(pronounSignal.status, "invalid");
  assert.equal(projectStyleClearFromQualityLoop(assessment), false);
});

test("qualityLoop：中盘仅 residual 高 → style_residual risk 可 continue，styleClear true", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "ch-40",
    chapterOrder: 40,
    score: {
      coherence: 90,
      pacing: 90,
      repetition: 90,
      engagement: 90,
      voice: 90,
      overall: 90,
    },
    issues: [],
    runtimePackage: {
      context: { chapter: { order: 40 } },
      audit: { reports: [], openIssues: [] },
      failureClassification: {
        code: "none",
        summary: "",
        decisionReason: null,
        blockingObligations: [],
      },
      styleReview: {
        autoRewritten: true,
        report: { riskScore: 60, summary: "", canAutoRewrite: true, appliedRuleIds: [], violations: [] },
        residualReport: {
          riskScore: 50,
          summary: "",
          canAutoRewrite: true,
          appliedRuleIds: [],
          violations: [],
        },
      },
    },
  });
  const residualSignal = assessment.signals.find((s) => s.artifactType === "style_residual");
  assert.ok(residualSignal, "中盘仍记 style_residual 债");
  assert.equal(residualSignal.status, "risk");
  assert.equal(projectStyleClearFromQualityLoop(assessment), true);
  assert.equal(assessment.recommendedAction, "continue");
});
