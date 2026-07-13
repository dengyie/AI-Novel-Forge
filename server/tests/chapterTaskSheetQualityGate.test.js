const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assessChapterExecutionContractShape,
  aiChapterTaskSheetQualityAssessmentSchema,
  formatChapterTaskSheetQualityFailure,
  inferChapterTaskSheetType,
  getChapterTaskSheetObligationBudget,
  stripInternalQualityCodes,
  containsInternalQualityCodes,
  sanitizeChapterTaskSheetForPersistence,
  sanitizeWriterFacingTaskSheet,
  tryAutoRepairInternalCodesOnly,
} = require("../../shared/dist/types/chapterTaskSheetQuality.js");
const {
  ChapterTaskSheetQualityGateService,
} = require("../dist/services/novel/volume/ChapterTaskSheetQualityGateService.js");
const {
  chapterTaskSheetQualityPrompt,
} = require("../dist/prompting/prompts/novel/volume/chapterTaskSheetQuality.prompts.js");

function buildSceneCards() {
  return JSON.stringify({
    targetWordCount: 3000,
    lengthBudget: {
      targetWordCount: 3000,
      softMinWordCount: 2550,
      softMaxWordCount: 3450,
      hardMaxWordCount: 3750,
    },
    scenes: [
      {
        key: "scene-1",
        title: "入口压力",
        purpose: "让主角被迫正面处理新的资源危机。",
        mustAdvance: ["暴露危机来源"],
        mustPreserve: ["不提前解决最终对手"],
        entryState: "主角刚拿到异常线索。",
        exitState: "主角确认危机来自内部。",
        forbiddenExpansion: ["不要直接揭开幕后人身份"],
        targetWordCount: 1000,
      },
      {
        key: "scene-2",
        title: "主动试探",
        purpose: "让主角用低成本方案试探对方底线。",
        mustAdvance: ["获得一个可验证证据"],
        mustPreserve: ["保留关系张力"],
        entryState: "主角掌握第一条线索。",
        exitState: "对手被迫露出反常反应。",
        forbiddenExpansion: ["不要让冲突直接收束"],
        targetWordCount: 1000,
      },
      {
        key: "scene-3",
        title: "结尾钩子",
        purpose: "把局面推到下一章入口。",
        mustAdvance: ["留下更大的追查方向"],
        mustPreserve: ["不兑现下一章核心事件"],
        entryState: "主角确认对手有破绽。",
        exitState: "新证据指向更危险的入口。",
        forbiddenExpansion: ["不要提前解决下一章标题事件"],
        targetWordCount: 1000,
      },
    ],
  });
}

function buildCandidate(overrides = {}) {
  return {
    novelId: "novel-1",
    volumeId: "volume-1",
    chapterId: "chapter-1",
    chapterOrder: 1,
    title: "第一章 危机入局",
    summary: "主角发现资源危机并开始试探。",
    purpose: "推进主角从被动承压转为主动试探。",
    exclusiveEvent: "主角第一次确认资源危机来自内部。",
    endingState: "主角拿到第一份证据。",
    nextChapterEntryState: "主角带着证据进入下一轮试探。",
    conflictLevel: 45,
    revealLevel: 35,
    targetWordCount: 3000,
    mustAvoid: "不要提前揭示幕后主使，不要复写下一章核心事件。",
    payoffRefs: ["资源危机"],
    taskSheet: "本章以资源危机开场，主角从被动承压转为主动试探，结尾留下更危险的证据入口。",
    sceneCards: buildSceneCards(),
    ...overrides,
  };
}

test("chapter execution contract shape gate blocks invalid task sheet artifacts", () => {
  const result = assessChapterExecutionContractShape(buildCandidate({
    taskSheet: "",
    sceneCards: null,
  }));

  assert.equal(result.canEnterExecution, false);
  assert.equal(result.status, "repairable");
  assert.ok(result.issues.some((issue) => issue.id === "missing_task_sheet"));
  assert.ok(result.issues.some((issue) => issue.id === "invalid_scene_cards"));
  assert.match(formatChapterTaskSheetQualityFailure(result), /章节执行合同/);
});

test("chapter task sheet quality service lets full book mode auto-repair semantic failures", async () => {
  const service = new ChapterTaskSheetQualityGateService(async () => ({
    verdict: "repairable",
    safeToSync: false,
    summary: "任务单可修复，但当前版本仍会越界。",
    issues: [
      {
        id: "semantic_boundary_leak",
        severity: "high",
        target: "semantic",
        summary: "任务单提前兑现下一章事件。",
        repairHint: "把下一章事件改成入口钩子，不要在本章完成。",
      },
    ],
    repairGuidance: ["收回下一章事件，只保留下章入口。"],
    confidence: 0.82,
  }));

  const result = await service.evaluate(buildCandidate(), {
    mode: "full_book_autopilot",
  });

  assert.equal(result.canEnterExecution, false);
  assert.equal(result.status, "repairable");
  assert.equal(result.issues[0].id, "semantic_boundary_leak");
});

test("chapter task sheet quality schema normalizes common assessment enum drift", () => {
  const parsed = aiChapterTaskSheetQualityAssessmentSchema.parse({
    verdict: "pass",
    safeToSync: true,
    loadRisk: "normal",
    recommendedHandling: "use_as_is",
    summary: "任务单可进入正文生成。",
    issues: [{
      id: "pacing_issue",
      severity: "medium",
      target: "pacing",
      summary: "节奏段缺少阶段性转向。",
      repairHint: "把一章改成主动反击或阶段兑现。",
    }],
    repairGuidance: [],
    confidence: 85,
  });

  assert.equal(parsed.verdict, "usable");
  assert.equal(parsed.issues[0].target, "semantic");
  assert.equal(parsed.confidence, 0.85);
});

test("chapter task sheet quality prompt declares strict JSON contract", () => {
  const messages = chapterTaskSheetQualityPrompt.render({
    candidate: buildCandidate(),
    mode: "full_book_autopilot",
  });
  const systemText = String(messages[0].content);

  assert.match(systemText, /verdict 只能使用 usable、repairable、unusable/);
  assert.match(systemText, /issues\.target 只能使用 purpose、boundary、task_sheet、scene_cards、semantic/);
  assert.match(systemText, /confidence 必须是 0 到 1 之间的小数/);
  assert.match(systemText, /"verdict": "repairable"/);
});

test("chapter task sheet quality service marks overloaded contracts for window replan", async () => {
  const service = new ChapterTaskSheetQualityGateService(async () => ({
    verdict: "repairable",
    safeToSync: false,
    loadRisk: "overloaded",
    recommendedHandling: "replan_window",
    summary: "本章同时承担多条 payoff 和多名角色转折，职责过载。",
    issues: [],
    repairGuidance: ["把其中一条 payoff 和一个角色转折拆到下一章。"],
    confidence: 0.86,
  }));

  const result = await service.evaluate(buildCandidate(), {
    mode: "full_book_autopilot",
  });

  assert.equal(result.canEnterExecution, false);
  assert.equal(result.status, "repairable");
  assert.ok(result.issues.some((issue) => issue.id === "contract_overloaded"));
});

test("chapter task sheet quality service passes usable semantic assessments", async () => {
  const service = new ChapterTaskSheetQualityGateService(async () => ({
    verdict: "usable",
    safeToSync: true,
    summary: "任务单和场景卡可进入正文生成。",
    issues: [],
    repairGuidance: [],
    confidence: 0.9,
  }));

  const result = await service.evaluate(buildCandidate(), {
    mode: "ai_copilot",
  });

  assert.equal(result.canEnterExecution, true);
  assert.equal(result.status, "passed");
  assert.equal(result.confidence, 0.9);
});

test("inferChapterTaskSheetType distinguishes emotion vs combat and budgets emotion lower", () => {
  const emotionType = inferChapterTaskSheetType({
    title: "雨夜和解",
    summary: "两人摊开误会，重建羁绊。",
    purpose: "推进情感关系并完成和解。",
    exclusiveEvent: "第一次坦诚心意",
    taskSheet: "用对话与陪伴完成情感兑现，控制节奏。",
    conflictLevel: 25,
  });
  const combatType = inferChapterTaskSheetType({
    title: "巷口伏击",
    summary: "主角突围并反杀追兵。",
    purpose: "打赢遭遇战并夺取出口。",
    exclusiveEvent: "第一次击溃追兵小队",
    taskSheet: "开场交手，中段追击，结尾突围。",
    conflictLevel: 85,
  });
  assert.equal(emotionType, "emotion");
  assert.equal(combatType, "combat");
  const emotionBudget = getChapterTaskSheetObligationBudget(emotionType);
  const combatBudget = getChapterTaskSheetObligationBudget(combatType);
  assert.ok(emotionBudget.maxHardObligationHints < combatBudget.maxHardObligationHints);
});

test("task sheet with internal quality codes is blocked; strip removes them", () => {
  const dirty = "推进资源危机；payoff_missing_progress；draft_obligation_unmet 后收尾。";
  assert.equal(containsInternalQualityCodes(dirty), true);
  const cleaned = stripInternalQualityCodes(dirty);
  assert.equal(containsInternalQualityCodes(cleaned), false);
  assert.match(cleaned, /资源危机/);

  const result = assessChapterExecutionContractShape(buildCandidate({
    taskSheet: dirty,
  }));
  assert.equal(result.canEnterExecution, false);
  assert.ok(result.issues.some((issue) => issue.id === "task_sheet_internal_codes"));
});

test("strip-only internal codes leaves empty task sheet and remains non-enterable if assessed raw", () => {
  const onlyCodes = "payoff_missing_progress draft_obligation_unmet replan_required";
  assert.equal(containsInternalQualityCodes(onlyCodes), true);
  const cleaned = stripInternalQualityCodes(onlyCodes);
  assert.equal(cleaned.trim(), "");
  // 清洗后为空：persist 路径应 hard fail；shape 对空单也应不可执行
  const emptyResult = assessChapterExecutionContractShape(buildCandidate({
    taskSheet: cleaned,
  }));
  assert.equal(emptyResult.canEnterExecution, false);
});

test("sanitizeChapterTaskSheetForPersistence strips codes and nulls empty residue", () => {
  const dirty = "推进资源危机；payoff_missing_progress；draft_obligation_unmet 后收尾。";
  const sanitized = sanitizeChapterTaskSheetForPersistence(dirty);
  assert.ok(sanitized);
  assert.equal(containsInternalQualityCodes(sanitized), false);
  assert.match(sanitized, /资源危机/);
  assert.match(sanitized, /收尾/);

  assert.equal(sanitizeChapterTaskSheetForPersistence(null), null);
  assert.equal(sanitizeChapterTaskSheetForPersistence(undefined), null);
  assert.equal(
    sanitizeChapterTaskSheetForPersistence("payoff_missing_progress replan_required"),
    null,
  );

  // narrative prose without codes is preserved
  const clean = "用对话完成关系推进，章末留下未兑现的线索。";
  assert.equal(sanitizeChapterTaskSheetForPersistence(clean), clean);
});

test("sanitizeWriterFacingTaskSheet never returns null", () => {
  assert.equal(sanitizeWriterFacingTaskSheet(null), "");
  assert.equal(sanitizeWriterFacingTaskSheet("payoff_missing_progress"), "");
  assert.match(
    sanitizeWriterFacingTaskSheet("推进A；draft_obligation_unmet；收尾B"),
    /推进A/,
  );
});

test("tryAutoRepairInternalCodesOnly repairs only codes; assess remains pure", () => {
  const dirty = buildCandidate({
    taskSheet: "推进资源危机；payoff_missing_progress；后收尾。",
  });
  const { repaired, stripped, emptiedTaskSheet } = tryAutoRepairInternalCodesOnly(dirty);
  assert.equal(stripped, true);
  assert.equal(emptiedTaskSheet, false);
  assert.equal(containsInternalQualityCodes(repaired.taskSheet), false);
  // original candidate untouched
  assert.equal(containsInternalQualityCodes(dirty.taskSheet), true);

  const after = assessChapterExecutionContractShape(repaired);
  assert.equal(after.canEnterExecution, true);
  assert.ok(!after.issues.some((issue) => issue.id === "task_sheet_internal_codes"));

  const onlyCodes = tryAutoRepairInternalCodesOnly(buildCandidate({
    taskSheet: "payoff_missing_progress replan_required",
  }));
  assert.equal(onlyCodes.stripped, true);
  assert.equal(onlyCodes.emptiedTaskSheet, true);
  const emptyAssess = assessChapterExecutionContractShape(onlyCodes.repaired);
  assert.equal(emptyAssess.canEnterExecution, false);
  assert.ok(emptyAssess.issues.some((issue) => issue.id === "missing_task_sheet"));

  const clean = tryAutoRepairInternalCodesOnly(buildCandidate({
    taskSheet: "正常推进，无内部码。",
  }));
  assert.equal(clean.stripped, false);
  assert.equal(clean.emptiedTaskSheet, false);
});

test("emotion chapter overloaded task sheet yields type overload hint without hard-blocking alone", () => {
  const heavyEmotionSheet = [
    "情绪基调：压抑后回温。",
    "冲突对象：旧误会。",
    "推进1：摊牌。",
    "推进2：系统任务结算。",
    "推进3：据点战准备。",
    "推进4：多线 payoff 同时触达。",
    "推进5：角色战力复核。",
    "收尾：再埋下一章钩子。",
  ].join("\n");
  const result = assessChapterExecutionContractShape(buildCandidate({
    title: "雨夜和解",
    purpose: "推进情感关系并完成和解。",
    exclusiveEvent: "第一次坦诚心意",
    taskSheet: heavyEmotionSheet,
    conflictLevel: 20,
    payoffRefs: ["关系回温", "系统结算", "据点战", "战力复核", "下一章钩子"],
  }));
  assert.ok(result.issues.some((issue) => issue.id === "task_sheet_type_overload"));
  // medium-only overload remains enterable for semantic assessor
  assert.equal(result.canEnterExecution, true);
});

test("chapter task sheet quality prompt is registered as a product prompt asset", () => {
  const registrySource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "prompting", "registry.ts"),
    "utf8",
  );
  assert.match(registrySource, /novel\.volume\.chapter_task_sheet_quality@v1/);
});
