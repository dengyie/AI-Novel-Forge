const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateSettingAlignmentRules,
  settingAlignmentToQualityLoopSignal,
  qualityLoopHasSettingBlockingSignal,
  hasBlockingSettingAlignmentDebt,
  SETTING_ALIGNMENT_RULE_ENGINE_VERSION,
} = require("@ai-novel/shared/types/settingAlignment");

const {
  buildChapterQualityLoopAssessment,
  classifyChapterQualityLoopRisk,
  classifyChapterQualityLoopRiskFlags,
} = require("@ai-novel/shared/types/chapterQualityLoop");

const {
  isDirectorAutoExecutionChapterProcessed,
  hasBlockingQualityLoopDebtForAutoExecution,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecution.js");

const {
  chapterSettingAlignmentService,
} = require("../dist/services/novel/quality/ChapterSettingAlignmentService.js");

const {
  assessSettingAlignmentForQualityLoop,
} = require("../dist/services/novel/quality/settingAlignmentPipelineHook.js");

function score(overrides = {}) {
  return {
    coherence: 88,
    repetition: 88,
    pacing: 86,
    voice: 85,
    engagement: 88,
    overall: 87,
    ...overrides,
  };
}

function functionItem(overrides = {}) {
  return {
    id: "fn-trust",
    order: 1,
    title: "陆深托付",
    mustHappen: "陆深当面托付关键事务",
    mustNotHappen: ["超自然外挂开局"],
    acceptanceChecks: ["托付对话落地", "承接人在场"],
    status: "assigned",
    ...overrides,
  };
}

test("mode=off skips rule engine with pass", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "完全无关正文",
    mode: "off",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
    hardForbiddenTerms: ["脱序者"],
  });
  assert.equal(assessment.status, "pass");
  assert.equal(assessment.recommendedAction, "continue");
  assert.equal(assessment.checks.length, 0);
  assert.equal(assessment.mode, "off");
});

test("enforce hard forbid becomes blocking", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "他唤醒了脱序者，局势失控。",
    mode: "enforce",
    hardForbiddenTerms: ["脱序者"],
  });
  assert.equal(assessment.status, "blocking");
  assert.equal(assessment.recommendedAction, "manual_gate");
  assert.ok(assessment.checks.some((c) => !c.passed && c.hard));
  assert.equal(assessment.ruleEngineVersion, SETTING_ALIGNMENT_RULE_ENGINE_VERSION);
});

test("advisory hard forbid is repairable non-blocking action continue", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "他唤醒了脱序者，局势失控。",
    mode: "advisory",
    hardForbiddenTerms: ["脱序者"],
  });
  assert.equal(assessment.status, "repairable");
  assert.equal(assessment.recommendedAction, "continue");
});

test("function acceptance keywords hit pass under enforce", () => {
  const content = "陆深当面托付关键事务，托付对话落地，承接人在场，没有外挂。";
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content,
    mode: "enforce",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
  });
  assert.equal(assessment.status, "pass");
  assert.equal(assessment.recommendedAction, "continue");
});

test("function missing keywords is soft repairable under enforce (not hard-block)", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "今天天气不错，什么也没发生。",
    mode: "enforce",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
  });
  // 功能线索未命中：soft → repairable / patch_repair，避免转述误杀；
  // 仍进 qualityLoop risk，enforce 下不可 defer 放行。
  assert.equal(assessment.status, "repairable");
  assert.equal(assessment.recommendedAction, "patch_repair");
  const fnCheck = assessment.checks.find((c) => c.id === "function:fn-trust");
  assert.ok(fnCheck && !fnCheck.passed && fnCheck.hard === false);
  const signal = settingAlignmentToQualityLoopSignal(assessment);
  assert.equal(signal.status, "risk");
  assert.equal(signal.blockingForQualityLoop, true);
});

test("function keyword negation window does not false-pass", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "陆深当面托付关键事务的说法不成立，托付对话落地并未发生，承接人在场也谈不上。",
    mode: "enforce",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
  });
  // 正文出现锚点但被否定窗包裹 → 不得 pass
  assert.notEqual(assessment.status, "pass");
  assert.ok(assessment.checks.some((c) => c.id === "function:fn-trust" && !c.passed));
});

test("function paraphrase without exact keyword recovers via soft semantic accept", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "陆深把关键事务当面交给了承接人，两人确认了后续安排，现场没有外挂。",
    mode: "enforce",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
  });
  // 转述：语义兑付锚（交给/确认了后续）应 recovery pass，永不 hard-block
  assert.notEqual(assessment.status, "blocking");
  const fnCheck = assessment.checks.find((c) => c.id === "function:fn-trust");
  assert.ok(fnCheck);
  assert.equal(fnCheck.hard, false);
  assert.equal(fnCheck.passed, true);
  assert.equal(assessment.status, "pass");
  assert.match(fnCheck.summary, /语义兑付|验收线索命中/);
});

test("function semantic miss remains soft repairable not hard-block", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "走廊空无一人，只有风声。",
    mode: "enforce",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
  });
  assert.equal(assessment.status, "repairable");
  const fnCheck = assessment.checks.find((c) => c.id === "function:fn-trust");
  assert.ok(fnCheck && !fnCheck.passed && fnCheck.hard === false);
});

test("llmChecks soft only never hard-block even when marked hard", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "走廊空无一人。",
    mode: "enforce",
    functionIds: [],
    llmUsed: true,
    llmChecks: [{
      id: "llm:semantic:fn-trust",
      kind: "function",
      passed: false,
      severity: "high",
      summary: "LLM 认为托付未兑付",
      hard: true,
    }],
  });
  assert.notEqual(assessment.status, "blocking");
  assert.ok(assessment.checks.every((c) => c.id !== "llm:semantic:fn-trust" || c.hard === false));
});

test("defer_and_continue cannot mask setting invalid / enforce risk", () => {
  const hardSetting = evaluateSettingAlignmentRules({
    chapterId: "chapter-defer-hard",
    content: "脱序者出现",
    mode: "enforce",
    hardForbiddenTerms: ["脱序者"],
  });
  const hardAssessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-defer-hard",
    chapterOrder: 1,
    score: score({ overall: 60 }),
    issues: [],
    settingAlignment: hardSetting,
  });
  // 模拟 pipeline 误写 defer：分类器仍须 blocking
  const hardWithDefer = {
    ...hardAssessment,
    terminalAction: "defer_and_continue",
  };
  assert.equal(classifyChapterQualityLoopRisk(hardWithDefer), "blocking");
  assert.equal(hasBlockingQualityLoopDebtForAutoExecution({
    riskFlags: JSON.stringify({ qualityLoop: hardWithDefer, settingAlignment: hardSetting }),
  }), true);
  assert.equal(isDirectorAutoExecutionChapterProcessed({
    id: "chapter-defer-hard",
    order: 1,
    content: "脱序者出现",
    generationState: "reviewed",
    chapterStatus: "pending_review",
    riskFlags: JSON.stringify({ qualityLoop: hardWithDefer, settingAlignment: hardSetting }),
  }), false);

  // enforce function soft miss → risk，同样不可 defer 放行
  const softSetting = evaluateSettingAlignmentRules({
    chapterId: "chapter-defer-soft",
    content: "今天天气不错。",
    mode: "enforce",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
  });
  const softAssessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-defer-soft",
    chapterOrder: 2,
    score: score({ overall: 60 }),
    issues: [],
    settingAlignment: softSetting,
  });
  const softWithDefer = {
    ...softAssessment,
    terminalAction: "defer_and_continue",
  };
  assert.equal(classifyChapterQualityLoopRisk(softWithDefer), "blocking");
  assert.equal(hasBlockingSettingAlignmentDebt(JSON.stringify({
    qualityLoop: softWithDefer,
    settingAlignment: softSetting,
  })), true);
});

test("mustNotHappen ban in content hard-fails", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "陆深当面托付关键事务，托付对话落地，承接人在场，却是超自然外挂开局。",
    mode: "enforce",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
  });
  assert.equal(assessment.status, "blocking");
  assert.ok(assessment.checks.some((c) => c.kind === "forbid" && !c.passed));
});

test("LLM timeout alone does not block under enforce", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "陆深当面托付关键事务，托付对话落地，承接人在场。",
    mode: "enforce",
    functionIds: ["fn-trust"],
    functionItems: [functionItem()],
    llmUsed: true,
    llmTimedOut: true,
    llmError: "timeout",
    llmChecks: [{
      id: "llm:soft",
      kind: "function",
      passed: false,
      severity: "medium",
      summary: "LLM 超时前的模糊提示",
      hard: true, // 应被降级为 soft
    }],
  });
  // soft fail only → repairable patch，不是 hard blocking
  assert.notEqual(assessment.status, "blocking");
  assert.equal(assessment.llmTimedOut, true);
  assert.ok(assessment.checks.every((c) => c.id !== "llm:soft" || c.hard === false));
});

test("settingAlignmentToQualityLoopSignal maps enforce hard to invalid blocking", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "脱序者出现",
    mode: "enforce",
    hardForbiddenTerms: ["脱序者"],
  });
  const signal = settingAlignmentToQualityLoopSignal(assessment);
  assert.equal(signal.artifactType, "setting_alignment");
  assert.equal(signal.status, "invalid");
  assert.equal(signal.blockingForQualityLoop, true);
});

test("settingAlignmentToQualityLoopSignal maps advisory fail to risk non-blocking", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "脱序者出现",
    mode: "advisory",
    hardForbiddenTerms: ["脱序者"],
  });
  const signal = settingAlignmentToQualityLoopSignal(assessment);
  assert.equal(signal.status, "risk");
  assert.equal(signal.blockingForQualityLoop, false);
  assert.match(signal.reason, /advisory|不阻断/);
});

test("qualityLoop merge: enforce setting hard → blocking + not processed", () => {
  const settingAlignment = evaluateSettingAlignmentRules({
    chapterId: "chapter-1",
    content: "脱序者出现",
    mode: "enforce",
    hardForbiddenTerms: ["脱序者"],
  });
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-1",
    chapterOrder: 1,
    score: score(),
    issues: [],
    settingAlignment,
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(assessment.signals.some((s) => s.artifactType === "setting_alignment"), true);
  assert.equal(assessment.recommendedAction, "manual_gate");
  assert.equal(classifyChapterQualityLoopRisk(assessment), "blocking");

  const riskFlags = JSON.stringify({ qualityLoop: assessment, settingAlignment });
  assert.equal(classifyChapterQualityLoopRiskFlags(riskFlags), "blocking");
  assert.equal(hasBlockingQualityLoopDebtForAutoExecution({ riskFlags }), true);
  assert.equal(isDirectorAutoExecutionChapterProcessed({
    id: "chapter-1",
    order: 1,
    content: "脱序者出现",
    generationState: "reviewed",
    chapterStatus: "pending_review",
    riskFlags,
  }), false);
  assert.equal(hasBlockingSettingAlignmentDebt(riskFlags), true);
  assert.equal(qualityLoopHasSettingBlockingSignal(assessment), true);
});

test("qualityLoop merge: advisory setting only → non_blocking, still processed", () => {
  const settingAlignment = evaluateSettingAlignmentRules({
    chapterId: "chapter-2",
    content: "脱序者出现",
    mode: "advisory",
    hardForbiddenTerms: ["脱序者"],
  });
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-2",
    chapterOrder: 2,
    score: score(),
    issues: [],
    settingAlignment,
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(assessment.recommendedAction, "continue");
  assert.equal(assessment.overallStatus, "risk");
  assert.equal(classifyChapterQualityLoopRisk(assessment), "non_blocking_quality_debt");

  const riskFlags = JSON.stringify({ qualityLoop: assessment, settingAlignment });
  assert.equal(hasBlockingQualityLoopDebtForAutoExecution({ riskFlags }), false);
  assert.equal(isDirectorAutoExecutionChapterProcessed({
    id: "chapter-2",
    order: 2,
    content: "脱序者出现",
    generationState: "reviewed",
    chapterStatus: "pending_review",
    riskFlags,
  }), true);
  // 仅 settingAlignment 详情、qualityLoop 无 blocking → 不双源
  assert.equal(hasBlockingSettingAlignmentDebt(JSON.stringify({
    settingAlignment,
  })), false);
});

test("writing only settingAlignment detail without qualityLoop merge does not block processed", () => {
  const settingAlignment = evaluateSettingAlignmentRules({
    chapterId: "chapter-3",
    content: "脱序者出现",
    mode: "enforce",
    hardForbiddenTerms: ["脱序者"],
  });
  // 故意只写详情、不归并 qualityLoop —— 实现 bug 场景的回归：processed 仍 true
  const riskFlags = JSON.stringify({ settingAlignment });
  assert.equal(hasBlockingQualityLoopDebtForAutoExecution({ riskFlags }), false);
  assert.equal(isDirectorAutoExecutionChapterProcessed({
    id: "chapter-3",
    order: 3,
    content: "脱序者出现",
    generationState: "reviewed",
    chapterStatus: "pending_review",
    riskFlags,
  }), true);
  assert.equal(hasBlockingSettingAlignmentDebt(riskFlags), false);
});

test("prose high score does not force setting pass under enforce", () => {
  const settingAlignment = evaluateSettingAlignmentRules({
    chapterId: "chapter-4",
    content: "脱序者出现",
    mode: "enforce",
    hardForbiddenTerms: ["脱序者"],
  });
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-4",
    chapterOrder: 4,
    score: score({ overall: 99, engagement: 99, coherence: 99 }),
    issues: [],
    settingAlignment,
  });
  assert.equal(assessment.recommendedAction, "manual_gate");
  assert.equal(classifyChapterQualityLoopRisk(assessment), "blocking");
});

test("ChapterSettingAlignmentService does not inject HIGH_CONFIDENCE terms by default", () => {
  const assessment = chapterSettingAlignmentService.assess({
    chapterId: "c1",
    content: "名噬回声在耳边响起。",
    mode: "enforce",
  });
  // 跨书默认不 hardban 源世界发明词，避免误杀
  assert.notEqual(assessment.status, "blocking");
  assert.ok(!assessment.checks.some((c) => c.evidence === "名噬回声"));
});

test("ChapterSettingAlignmentService injects HIGH_CONFIDENCE terms when opt-in", () => {
  const assessment = chapterSettingAlignmentService.assess({
    chapterId: "c1",
    content: "名噬回声在耳边响起。",
    mode: "enforce",
    includeHighConfidenceInventedTerms: true,
  });
  assert.equal(assessment.status, "blocking");
  assert.ok(assessment.checks.some((c) => !c.passed && (c.evidence === "名噬回声" || c.summary.includes("名噬回声"))));
});

test("assessSettingAlignmentForQualityLoop returns null when mode off", () => {
  const result = assessSettingAlignmentForQualityLoop({
    novelId: "n1",
    chapterId: "c1",
    chapterOrder: 1,
    content: "脱序者",
    mode: "off",
  });
  assert.equal(result, null);
});

test("assessSettingAlignmentForQualityLoop returns assessment when enforce", () => {
  const result = assessSettingAlignmentForQualityLoop({
    novelId: "n1",
    chapterId: "c1",
    chapterOrder: 1,
    content: "脱序者",
    mode: "enforce",
    hardForbiddenTerms: ["脱序者"],
  });
  assert.ok(result);
  assert.equal(result.status, "blocking");
});

test("assessSettingAlignmentForQualityLoop injects functionIds from volumeDocument", () => {
  const volumeDocument = {
    novelId: "n1",
    volumes: [{
      id: "vol-1",
      order: 1,
      title: "卷一",
      chapters: [{
        id: "ch-1",
        chapterId: "c1",
        chapterOrder: 1,
        title: "托付",
        functionIds: ["fn-trust"],
        exclusiveEvent: null,
        mustAvoid: null,
      }],
    }],
    functionAcceptanceTables: [{
      volumeId: "vol-1",
      items: [functionItem()],
    }],
  };
  const result = assessSettingAlignmentForQualityLoop({
    novelId: "n1",
    chapterId: "c1",
    chapterOrder: 1,
    content: "今天天气不错，什么也没发生。",
    mode: "enforce",
    volumeDocument,
  });
  assert.ok(result);
  assert.ok(result.checks.some((c) => c.id === "function:fn-trust" && !c.passed && c.hard === false));
  assert.equal(result.status, "repairable");
});

test("required character appearance missing hard-fails enforce", () => {
  const assessment = evaluateSettingAlignmentRules({
    chapterId: "c1",
    content: "空荡的走廊里没有人影。",
    mode: "enforce",
    requiredCharacterAppearances: ["陆深"],
  });
  assert.equal(assessment.status, "blocking");
  assert.ok(assessment.checks.some((c) => c.kind === "entity" && !c.passed));
});

test("mode=off qualityLoop assessment has no setting_alignment signal", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "c-off",
    chapterOrder: 1,
    score: score(),
    issues: [],
    // 不传 settingAlignment
  });
  assert.equal(assessment.signals.length, 4);
  assert.ok(assessment.signals.every((s) => s.artifactType !== "setting_alignment"));
  assert.equal(assessment.recommendedAction, "continue");
});
