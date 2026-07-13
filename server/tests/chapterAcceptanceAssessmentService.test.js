const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeAssessment,
  isHardMissingObligation,
  partitionHardSoftMissingObligations,
} = require("../dist/services/novel/runtime/ChapterAcceptanceAssessmentService.js");
const {
  buildFailureClassification,
  buildObligationCoverage,
} = require("../dist/services/novel/runtime/chapterRuntimePackageBuilders.js");

function createAssessment(overrides = {}) {
  return {
    status: "accepted",
    score: {
      coherence: 82,
      pacing: 82,
      repetition: 82,
      engagement: 82,
      voice: 82,
      overall: 82,
    },
    summary: "chapter accepted",
    blockingIssues: [],
    repairDirectives: [],
    riskTags: [],
    assetSyncRecommendation: {
      priority: "normal",
      reason: "normal sync",
      requiresFullPayoffReconcile: false,
    },
    continuePolicy: "continue",
    ...overrides,
  };
}

test("normalizeAssessment drops stale under-length issue when actual content satisfies target range", () => {
  const content = "字".repeat(6025);
  const normalized = normalizeAssessment(createAssessment({
    status: "needs_manual_review",
    blockingIssues: [{
      severity: "high",
      category: "plot",
      code: "length_insufficient",
      evidence: "正文估算约2000-3000字，远低于目标长度5100-6900字范围。",
      fixSuggestion: "扩写到目标字数。",
    }, {
      severity: "medium",
      category: "plot",
      code: "payoff_missing_progress",
      evidence: "赵明相关线索缺失。",
      fixSuggestion: "补充赵明微笑暗示的真正游戏。",
    }],
    repairDirectives: [{
      mode: "rewrite",
      target: "plot",
      instruction: "扩写正文到目标长度。",
    }, {
      mode: "patch",
      target: "plot",
      instruction: "补充赵明微笑暗示的真正游戏。",
    }],
    riskTags: ["length_insufficient", "payoff_missing_progress"],
    continuePolicy: "pause",
  }), content, 6000);

  assert.equal(normalized.status, "repairable");
  assert.equal(normalized.continuePolicy, "repair_once");
  assert.deepEqual(normalized.blockingIssues.map((issue) => issue.code), ["payoff_missing_progress"]);
  assert.deepEqual(normalized.repairDirectives.map((directive) => directive.instruction), ["补充赵明微笑暗示的真正游戏。"]);
  assert.deepEqual(normalized.riskTags, ["payoff_missing_progress"]);
});

test("normalizeAssessment keeps under-length issue when actual content is still below target range", () => {
  const normalized = normalizeAssessment(createAssessment({
    status: "repairable",
    blockingIssues: [{
      severity: "high",
      category: "plot",
      code: "length_insufficient",
      evidence: "正文估算远低于目标长度。",
      fixSuggestion: "扩写到目标字数。",
    }],
    repairDirectives: [{
      mode: "rewrite",
      target: "plot",
      instruction: "扩写正文到目标长度。",
    }],
    riskTags: ["length_insufficient"],
    continuePolicy: "repair_once",
  }), "字".repeat(3000), 6000);

  assert.equal(normalized.status, "repairable");
  assert.equal(normalized.continuePolicy, "repair_once");
  assert.deepEqual(normalized.blockingIssues.map((issue) => issue.code), ["length_insufficient"]);
  assert.ok(normalized.riskTags.includes("length_under_soft"));
});

test("normalizeAssessment injects over_hard risk tag without hard-blocking accepted chapters", () => {
  const normalized = normalizeAssessment(createAssessment({
    status: "accepted",
    riskTags: [],
    continuePolicy: "continue",
  }), "字".repeat(4000), 2800);

  assert.equal(normalized.status, "accepted");
  assert.equal(normalized.continuePolicy, "continue");
  assert.ok(normalized.riskTags.includes("length_over_hard"));
  assert.equal(normalized.blockingIssues.length, 0);
});

test("normalizeAssessment routes soft-only missing obligations with patchable_obligation_gap to continue_with_risk", () => {
  const normalized = normalizeAssessment(createAssessment({
    status: "accepted",
    missingObligations: [{
      kind: "payoff_touch",
      summary: "补出截信计划的可见行动。",
      evidence: "正文只回忆了计划，没有发生行动。",
    }],
    repairability: "patchable_obligation_gap",
    decisionReason: "只需局部补写即可兑现本章义务。",
  }), "字".repeat(3600), 3000);

  assert.equal(normalized.status, "continue_with_risk");
  assert.equal(normalized.missingObligations[0].kind, "payoff_touch");
});

test("intentional offscreen character_appearance stays soft and does not hard-block", () => {
  const normalized = normalizeAssessment(createAssessment({
    status: "accepted",
    missingObligations: [{
      kind: "character_appearance",
      summary: "配角春桃未出场。",
      evidence: "正文未出现春桃；该角色他章计划 / offscreen。",
    }],
    repairability: "patchable_obligation_gap",
    decisionReason: "非必须出场角色可延后。",
  }), "字".repeat(3600), 3000);

  assert.equal(normalized.status, "continue_with_risk");
  assert.match(normalized.missingObligations[0].summary, /可延后|offscreen/);
});

test("must_on_page character_appearance is hard and routes to repairable", () => {
  const normalized = normalizeAssessment(createAssessment({
    status: "accepted",
    missingObligations: [{
      kind: "character_appearance",
      summary: "林逸（must_on_page；已缺席 3 章，须本场可见）未出场。",
      evidence: "正文没有林逸的可见行动。",
    }],
    repairability: "patchable_obligation_gap",
    decisionReason: "必须出场角色缺席需补丁。",
  }), "字".repeat(3600), 3000);

  assert.equal(normalized.status, "repairable");
  assert.equal(normalized.continuePolicy, "repair_once");
});

test("plain character_appearance missing is hard when requiredCharacterAppearances lists the name", () => {
  // 合同已要求 must_on_page；LLM 只写「林逸未出场」也必须 hard → repairable
  const normalized = normalizeAssessment(createAssessment({
    status: "accepted",
    missingObligations: [{
      kind: "character_appearance",
      summary: "林逸未出场。",
      evidence: "正文无林逸可见行动。",
    }],
    repairability: "patchable_obligation_gap",
    decisionReason: "必须出场角色缺席。",
  }), "字".repeat(3600), 3000, {
    requiredCharacterAppearances: [
      "林逸（must_on_page；已缺席 3 章，须本场可见）",
    ],
  });

  assert.equal(normalized.status, "repairable");
  assert.equal(normalized.continuePolicy, "repair_once");
});

test("plain character_appearance missing stays soft without required contract match", () => {
  const normalized = normalizeAssessment(createAssessment({
    status: "accepted",
    missingObligations: [{
      kind: "character_appearance",
      summary: "路人甲未出场。",
      evidence: "正文未出现路人甲。",
    }],
    repairability: "patchable_obligation_gap",
    decisionReason: "非合同必达角色。",
  }), "字".repeat(3600), 3000, {
    requiredCharacterAppearances: [
      "林逸（must_on_page；本章计划出场）",
    ],
  });

  assert.equal(normalized.status, "continue_with_risk");
});

test("partitionHardSoftMissingObligations splits hard must_hit from soft payoff_touch", () => {
  const softPayoff = {
    kind: "payoff_touch",
    summary: "补出截信计划的可见行动。",
    evidence: "正文只回忆了计划。",
  };
  const hardMust = {
    kind: "must_hit_now",
    summary: "必须兑现本场关键转折。",
    evidence: "正文未出现约定转折。",
  };
  const hardAppearance = {
    kind: "character_appearance",
    summary: "林逸（must_on_page）未出场。",
    evidence: "正文无林逸。",
  };
  assert.equal(isHardMissingObligation(softPayoff), false);
  assert.equal(isHardMissingObligation(hardMust), true);
  assert.equal(isHardMissingObligation(hardAppearance), true);

  const { hard, soft } = partitionHardSoftMissingObligations(
    [softPayoff, hardMust, hardAppearance],
  );
  assert.equal(hard.length, 2);
  assert.equal(soft.length, 1);
  assert.equal(soft[0].kind, "payoff_touch");
});

test("buildFailureClassification soft-only missing is none not draft_obligation_unmet (P2-6)", () => {
  const softOnly = [{
    kind: "payoff_touch",
    summary: "补出截信计划的可见行动。",
    evidence: "正文只回忆了计划。",
  }];
  const acceptance = createAssessment({
    status: "continue_with_risk",
    missingObligations: softOnly,
    repairability: "patchable_obligation_gap",
    decisionReason: "软义务可后续回收。",
  });
  const classified = buildFailureClassification({
    acceptance,
    hasBlockingIssues: false,
    replanRecommended: false,
    missingObligations: softOnly,
    hardMissingObligations: [],
  });
  assert.equal(classified.code, "none");
  assert.deepEqual(classified.blockingObligations, []);
  assert.match(classified.summary, /软义务|可延后/);

  const coverage = buildObligationCoverage({
    missingObligations: softOnly,
    hasBlockingIssues: false,
    hardMissingObligations: [],
  });
  assert.equal(coverage.status, "partial");
  assert.equal(coverage.missing.length, 1);
});

test("buildFailureClassification hard missing still draft_obligation_unmet", () => {
  const hardOnly = [{
    kind: "must_hit_now",
    summary: "必须兑现本场关键转折。",
    evidence: "正文未出现约定转折。",
  }];
  const acceptance = createAssessment({
    status: "repairable",
    missingObligations: hardOnly,
    repairability: "patchable_obligation_gap",
    decisionReason: "硬义务未兑现。",
  });
  const classified = buildFailureClassification({
    acceptance,
    hasBlockingIssues: false,
    replanRecommended: false,
    missingObligations: hardOnly,
    hardMissingObligations: hardOnly,
  });
  assert.equal(classified.code, "draft_obligation_unmet");
  assert.equal(classified.blockingObligations.length, 1);
  assert.equal(classified.blockingObligations[0].kind, "must_hit_now");

  const coverage = buildObligationCoverage({
    missingObligations: hardOnly,
    hasBlockingIssues: false,
    hardMissingObligations: hardOnly,
  });
  assert.equal(coverage.status, "unmet");
});

test("buildFailureClassification without hardMissingObligations keeps legacy all-missing-as-hard", () => {
  // 旧调用方未传 hard 列表时：全部 missing 仍按 hard 处理，避免静默行为漂移
  const softListed = [{
    kind: "payoff_touch",
    summary: "软缺口",
    evidence: "e",
  }];
  const classified = buildFailureClassification({
    acceptance: createAssessment({
      status: "continue_with_risk",
      missingObligations: softListed,
      repairability: "patchable_obligation_gap",
      decisionReason: "legacy",
    }),
    hasBlockingIssues: false,
    replanRecommended: false,
    missingObligations: softListed,
  });
  assert.equal(classified.code, "draft_obligation_unmet");
});

test("normalizeAssessment lifts severely short chapter (under_hard) to blocking repair, never silent accepted", () => {
  // 字数 1500 < target 2800 × 0.6 (hardMin 1680) → under_hard 必须硬阻断。
  const content = "字".repeat(1500);
  const normalized = normalizeAssessment(createAssessment({
    status: "accepted",
  }), content, 2800);

  // 不得静默 approved。
  assert.notEqual(normalized.status, "accepted");
  // 必须进入需修复 / 需人工复查轨道（不可 continue / continue_with_risk 绕过）。
  assert.ok(
    normalized.status === "repairable" || normalized.status === "needs_manual_review",
    `unexpected under_hard status ${normalized.status}`,
  );
  // 注入 length_under_hard 硬阻断 issue。
  assert.ok(
    normalized.blockingIssues.some((issue) => issue.code === "length_under_hard"),
    "under_hard should inject a length_under_hard blocking issue",
  );
  // 风险标签包含 length_under_hard，便于后续非 skippable 检测。
  assert.ok(normalized.riskTags.includes("length_under_hard"));
  // continuePolicy 不允许是 continue（继续推进），必须是 repair_once 或 pause。
  assert.notEqual(normalized.continuePolicy, "continue");
});

test("normalizeAssessment does not drop under-length issue when content is severely short", () => {
  // 与上方 stale-drop 测试对照：内容远低于硬下限时，stale under-length issue 必须保留。
  const content = "字".repeat(1200);
  const normalized = normalizeAssessment(createAssessment({
    status: "needs_manual_review",
    blockingIssues: [{
      severity: "high",
      category: "plot",
      code: "length_insufficient",
      evidence: "正文估算约1200字，远低于目标2800字。",
      fixSuggestion: "扩写到目标字数。",
    }],
    repairDirectives: [{
      mode: "rewrite",
      target: "plot",
      instruction: "扩写正文到目标长度。",
    }],
    riskTags: ["length_insufficient"],
    continuePolicy: "pause",
  }), content, 2800);

  assert.ok(
    normalized.blockingIssues.some((issue) => issue.code === "length_insufficient" || issue.code === "length_under_hard"),
    "under-length issue must survive when content is severely short",
  );
});
