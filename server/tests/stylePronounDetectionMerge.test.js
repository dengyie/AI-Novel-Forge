const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapPronounFindingsToStyleViolations,
  computePronounRiskFloor,
  mergePronounIntoDetectionReport,
  collectPronounStyleViolations,
  HARD_PRONOUN_PROSE_CODES,
} = require("../dist/services/styleEngine/StyleDetectionService.js");
const {
  DEFAULT_ANTI_AI_RULES,
} = require("../dist/services/styleEngine/defaults.js");

// PostGenerationStyleReview 首轮 rewrite 门槛
const FIRST_ROUND_REWRITE_THRESHOLD = 35;

function emptyBaseReport(overrides = {}) {
  return {
    riskScore: 0,
    summary: "当前没有可执行的写法检测约束，未执行写法违规检测。",
    violations: [],
    canAutoRewrite: false,
    appliedRuleIds: [],
    ...overrides,
  };
}

test("HARD_PRONOUN_PROSE_CODES 仅含 stack + hard density（不含 soft）", () => {
  assert.deepEqual([...HARD_PRONOUN_PROSE_CODES].sort(), [
    "prose_pronoun_density",
    "prose_pronoun_subject_stack",
  ].sort());
});

test("defaults 含 forbid-pronoun-subject-stack：forbidden/high/autoRewrite/baseline，detectPatterns 空", () => {
  const rule = DEFAULT_ANTI_AI_RULES.find((item) => item.key === "forbid-pronoun-subject-stack");
  assert.ok(rule, "defaults 必须有 forbid-pronoun-subject-stack");
  assert.equal(rule.type, "forbidden");
  assert.equal(rule.severity, "high");
  assert.equal(rule.autoRewrite, true);
  assert.equal(rule.enabled, true);
  assert.equal(rule.globalBaselineEnabled, true);
  // 空 patterns：避免「他」字面量污染 clustering 计数
  assert.deepEqual(rule.detectPatterns, []);
  assert.ok(String(rule.promptInstruction || "").includes("他"));
});

test("mapPronounFindingsToStyleViolations：stack finding → rewritable style violation", () => {
  const violations = mapPronounFindingsToStyleViolations([
    {
      code: "prose_pronoun_subject_stack",
      severity: "high",
      message: "连续句首第三人称代词堆叠",
      excerpt: "他没有说话。他转身离开。他没有回头。他推开门。",
      fixSuggestion: "改用专名或动作起句",
    },
    {
      // soft 不得映射进 rewrite gate
      code: "prose_pronoun_density_soft",
      severity: "medium",
      message: "soft density",
      excerpt: "…",
      fixSuggestion: "…",
    },
  ]);
  assert.equal(violations.length, 1);
  const v = violations[0];
  assert.equal(v.ruleId, "l0:prose_pronoun_subject_stack");
  assert.equal(v.ruleType, "forbidden");
  assert.equal(v.severity, "high");
  assert.equal(v.source, "global_anti_ai");
  assert.equal(v.issueCategory, "style_expression");
  assert.equal(v.canAutoRewrite, true);
  assert.ok(v.suggestion.trim().length > 0);
  assert.equal(v.reason, "连续句首第三人称代词堆叠");
});

test("mapPronounFindingsToStyleViolations：prose critical → style high（AntiAiSeverity 无 critical）", () => {
  const violations = mapPronounFindingsToStyleViolations([
    {
      code: "prose_pronoun_subject_stack",
      severity: "critical",
      message: "critical stack",
      excerpt: "他…",
      fixSuggestion: "改写",
    },
  ]);
  assert.equal(violations[0].severity, "high");
});

test("mapPronounFindingsToStyleViolations：同 code 多 finding 合并为一条", () => {
  const violations = mapPronounFindingsToStyleViolations([
    {
      code: "prose_pronoun_density",
      severity: "medium",
      message: "a",
      excerpt: "ex-a",
      fixSuggestion: "fix",
    },
    {
      code: "prose_pronoun_density",
      severity: "high",
      message: "b",
      excerpt: "ex-b",
      fixSuggestion: "fix",
    },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].severity, "high");
  assert.equal(violations[0].ruleId, "l0:prose_pronoun_density");
});

test("computePronounRiskFloor：stack ≥ 首轮 rewrite 门槛 35", () => {
  const floor = computePronounRiskFloor([
    {
      ruleId: "l0:prose_pronoun_subject_stack",
      ruleName: "x",
      ruleType: "forbidden",
      severity: "high",
      source: "global_anti_ai",
      issueCategory: "style_expression",
      excerpt: "e",
      reason: "r",
      suggestion: "s",
      canAutoRewrite: true,
    },
  ]);
  assert.ok(floor >= FIRST_ROUND_REWRITE_THRESHOLD);
  assert.ok(floor >= 55);
});

test("computePronounRiskFloor：hard density 单独也 ≥ 35", () => {
  const floor = computePronounRiskFloor([
    {
      ruleId: "l0:prose_pronoun_density",
      ruleName: "x",
      ruleType: "forbidden",
      severity: "high",
      source: "global_anti_ai",
      issueCategory: "style_expression",
      excerpt: "e",
      reason: "r",
      suggestion: "s",
      canAutoRewrite: true,
    },
  ]);
  assert.ok(floor >= FIRST_ROUND_REWRITE_THRESHOLD);
  assert.equal(floor, 45);
});

test("computePronounRiskFloor：空 violations → 0", () => {
  assert.equal(computePronounRiskFloor([]), 0);
});

test("mergePronounIntoDetectionReport：覆盖 empty-contract 短路（risk 0 + 空 violations）", () => {
  const pronoun = collectPronounStyleViolations(
    Array.from({ length: 5 }, () => "他没有说话。").join(""),
  );
  assert.ok(pronoun.length >= 1, "5 句句首他应产出 hard pronoun violations");

  const merged = mergePronounIntoDetectionReport(emptyBaseReport(), pronoun);
  assert.ok(merged.riskScore >= FIRST_ROUND_REWRITE_THRESHOLD);
  assert.ok(merged.violations.some((v) => v.canAutoRewrite && v.suggestion.trim()));
  assert.ok(merged.violations.some((v) => v.ruleId === "l0:prose_pronoun_subject_stack"));
  assert.equal(merged.canAutoRewrite, true);
  assert.ok(merged.appliedRuleIds.includes("l0:prose_pronoun_subject_stack"));
  assert.ok(String(merged.summary).includes("代词") || String(merged.summary).includes("改写"));
});

test("mergePronounIntoDetectionReport：覆盖 shouldSkipLlm 等价报告（risk 0 仍抬分）", () => {
  const pronoun = collectPronounStyleViolations(
    Array.from({ length: 5 }, () => "他没有说话。").join(""),
  );
  const skipped = emptyBaseReport({
    summary: "快扫未检出字面量违禁词，也未构成 AI 痕迹聚类，跳过 LLM 深度检测。",
  });
  const merged = mergePronounIntoDetectionReport(skipped, pronoun);
  assert.ok(merged.riskScore >= FIRST_ROUND_REWRITE_THRESHOLD);
  assert.ok(merged.violations.length >= 1);
  assert.equal(merged.canAutoRewrite, true);
});

test("mergePronounIntoDetectionReport：已有同 ruleId 不重复，但 risk 仍抬", () => {
  const existing = {
    ruleId: "l0:prose_pronoun_subject_stack",
    ruleName: "LLM 已报",
    ruleType: "forbidden",
    severity: "high",
    source: "global_anti_ai",
    issueCategory: "style_expression",
    excerpt: "llm",
    reason: "llm",
    suggestion: "llm fix",
    canAutoRewrite: true,
  };
  const pronoun = [existing];
  const merged = mergePronounIntoDetectionReport(
    emptyBaseReport({
      riskScore: 10,
      violations: [existing],
      canAutoRewrite: true,
      appliedRuleIds: ["l0:prose_pronoun_subject_stack"],
      summary: "llm summary",
    }),
    pronoun,
  );
  assert.equal(
    merged.violations.filter((v) => v.ruleId === "l0:prose_pronoun_subject_stack").length,
    1,
  );
  assert.ok(merged.riskScore >= 55);
});

test("mergePronounIntoDetectionReport：无 pronoun 时原样返回 base", () => {
  const base = emptyBaseReport({ riskScore: 12, summary: "ok" });
  const merged = mergePronounIntoDetectionReport(base, []);
  assert.equal(merged.riskScore, 12);
  assert.equal(merged.summary, "ok");
  assert.equal(merged.violations.length, 0);
});

test("collectPronounStyleViolations：干净文本无 hard pronoun", () => {
  const clean = "沈晚推开窗。潮气扑进来。远处的灯火一层层熄灭。";
  assert.deepEqual(collectPronounStyleViolations(clean), []);
});
