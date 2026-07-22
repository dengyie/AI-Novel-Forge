const test = require("node:test");
const assert = require("node:assert/strict");
const promptRunner = require("../dist/prompting/core/promptRunner.js");

const fs = require("node:fs");
const path = require("node:path");
const {
  runPipelineChapterWithRuntime,
} = require("../dist/services/novel/runtime/chapterRuntimePipeline.js");
const {
  ChapterEmptyContentError,
} = require("../dist/services/novel/runtime/chapterEmptyContentError.js");
const {
  mergeChapterPatchForGenerationStateBump,
} = require("../dist/services/novel/chapterLifecycleState.js");

function createRuntimePackage(overallScore, options = {}) {
  return {
    novelId: "novel-1",
    chapterId: "chapter-1",
    audit: {
      score: {
        coherence: overallScore,
        pacing: overallScore,
        repetition: overallScore,
        engagement: overallScore,
        voice: overallScore,
        overall: overallScore,
      },
      openIssues: options.openIssues ?? [{
        auditType: "continuity",
        severity: "medium",
        evidence: "存在承接问题。",
        fixSuggestion: "补足承接。",
        code: "CONTINUITY_GAP",
      }],
      reports: [],
      hasBlockingIssues: options.hasBlockingIssues ?? false,
    },
    context: {
      chapterRepairContext: null,
      bookContract: null,
      macroConstraints: null,
      volumeWindow: null,
      styleContext: options.styleContext ?? null,
      chapter: options.chapter ?? { order: 1 },
    },
    timelineCheck: options.timelineCheck ?? { status: "passed" },
    styleReview: options.styleReview ?? undefined,
    meta: options.meta ?? {
      acceptanceStatus: "accepted",
      continuePolicy: "continue",
    },
  };
}

/** 文学门过、无 blocking、可进入 dual-gate mark 的 runtime 包。 */
function createDualGatePassPackage(overrides = {}) {
  return createRuntimePackage(90, {
    openIssues: [],
    hasBlockingIssues: false,
    chapter: { order: 1 },
    styleReview: {
      autoRewritten: false,
      report: {
        riskScore: 10,
        summary: "",
        canAutoRewrite: false,
        appliedRuleIds: [],
        violations: [],
      },
      residualReport: {
        riskScore: 10,
        summary: "",
        canAutoRewrite: false,
        appliedRuleIds: [],
        violations: [],
      },
    },
    ...overrides,
  });
}

function createAcceptanceGateUnavailableRuntimePackage(overallScore) {
  return {
    ...createRuntimePackage(overallScore),
    audit: {
      score: {
        coherence: overallScore,
        pacing: overallScore,
        repetition: overallScore,
        engagement: overallScore,
        voice: overallScore,
        overall: overallScore,
      },
      openIssues: [{
        auditType: "continuity",
        severity: "medium",
        evidence: "章节接收闸门未返回可用结构化结果，系统保留复查风险。",
        fixSuggestion: "重新审校章节接收判断，不直接修改正文。",
        code: "acceptance_gate_unavailable",
      }],
      reports: [],
      hasBlockingIssues: false,
    },
    meta: {
      acceptanceStatus: "continue_with_risk",
      continuePolicy: "continue",
      // 产品短路依赖 riskTag=acceptance_gate_unavailable（judge 失败唯一真源）
      riskTags: ["acceptance_gate_unavailable"],
    },
  };
}

function createProseRiskRuntimePackage(overallScore, options = {}) {
  const base = createRuntimePackage(overallScore, options);
  const severity = options.severity ?? "high";
  const issue = {
    auditType: "mode_fit",
    severity,
    evidence: "第 1 行：他不是害怕，而是终于明白自己不能回头。",
    fixSuggestion: "改成具体动作和感官细节，删除模板化否定翻转。",
    code: options.code ?? "prose_negative_flip",
  };
  return {
    ...base,
    audit: {
      ...base.audit,
      openIssues: [issue],
      reports: [{
        auditType: "mode_fit",
        issues: [issue],
      }],
      hasBlockingIssues: severity === "high" || severity === "critical",
    },
    meta: {
      acceptanceStatus: "accepted",
      continuePolicy: "continue",
    },
    replanRecommendation: {
      recommended: severity === "high" || severity === "critical",
      action: severity === "high" || severity === "critical" ? "local_patch_plan" : "continue_with_warning",
      reason: "Prose quality issue should stay local to the chapter.",
      blockingIssueIds: severity === "high" || severity === "critical" ? ["prose-negative-flip"] : [],
      blockingLedgerKeys: [],
      affectedChapterOrders: [],
    },
    failureClassification: {
      code: "draft_repair_exhausted",
      summary: "正文自然度问题仍未修复。",
      decisionReason: "prose quality issue stays local",
      blockingObligations: [],
    },
  };
}

test("runPipelineChapterWithRuntime skips review and repair when autoReview is disabled", async () => {
  const stages = [];
  const generationStates = [];
  const savedDrafts = [];
  const finalSyncs = [];
  const timelineFinalizationCalls = [];
  let finalizeCalled = false;

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        return { content: "生成后的正文" };
      },
      async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState, options) {
        savedDrafts.push({ content, generationState, options });
      },
      async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
        finalSyncs.push(content);
      },
      async finalizeChapterContent() {
        finalizeCalled = true;
        throw new Error("should not finalize");
      },
      async finalizeChapterTimeline(input) {
        timelineFinalizationCalls.push(input);
      },
        async markChapterGenerationState(_chapterId, generationState) {
          generationStates.push(generationState);
        },
        async markChapterNeedsRepair() {},
      },
    "novel-1",
    "chapter-1",
    {
      autoReview: false,
      autoRepair: true,
    },
    {
      async onStageChange(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(finalizeCalled, false);
  assert.equal(timelineFinalizationCalls.length, 0);
  assert.deepEqual(stages, ["generating_chapters"]);
  assert.deepEqual(savedDrafts, [{
    content: "生成后的正文",
    generationState: "drafted",
    options: {
      scheduleBackgroundSync: false,
      artifactSyncMode: "adaptive",
      syncArtifacts: false,
    },
  }]);
  assert.equal(finalSyncs.length, 1);
  assert.deepEqual(generationStates, ["approved"]);
  assert.equal(result.reviewExecuted, false);
  assert.equal(result.pass, true);
  assert.equal(result.retryCountUsed, 0);
  assert.deepEqual(result.issues, []);
  assert.equal(result.runtimePackage, null);
  assert.deepEqual(result.score, {
    coherence: 100,
    pacing: 100,
    repetition: 100,
    engagement: 100,
    voice: 100,
    overall: 100,
  });
});

test("runPipelineChapterWithRuntime does not approve when timeline check fails", async () => {
  const generationStates = [];
  const finalizedContent = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        return { content: "生成后的正文" };
      },
      async saveDraftAndArtifacts() {},
      async syncFinalChapterArtifacts() {},
      async finalizeChapterContent(input) {
        finalizedContent.push(input.content);
        return {
          finalContent: input.content,
          runtimePackage: {
            audit: {
              score: {
                coherence: 98,
                pacing: 98,
                repetition: 98,
                engagement: 98,
                voice: 98,
                overall: 98,
              },
              openIssues: [],
              reports: [],
              hasBlockingIssues: false,
            },
            meta: {
              acceptanceStatus: "accepted",
              continuePolicy: "continue",
            },
            timelineCheck: {
              status: "failed",
            },
            context: {
              styleContext: null,
            },
          },
        };
      },
      async markChapterGenerationState(_chapterId, generationState) {
        generationStates.push(generationState);
      },
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    {
      autoReview: true,
      autoRepair: false,
    },
  );

  assert.deepEqual(finalizedContent, ["生成后的正文"]);
  assert.deepEqual(generationStates, ["reviewed"]);
  assert.equal(result.pass, false);
  assert.equal(result.runtimePackage.timelineCheck.status, "failed");
});

test("runPipelineChapterWithRuntime passes confirmed provenance for approved final artifact sync", async () => {
  const finalSyncs = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: "已有正文",
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        throw new Error("existing content should not be regenerated");
      },
      async saveDraftAndArtifacts() {},
      async syncFinalChapterArtifacts(_novelId, _chapterId, content, options) {
        finalSyncs.push({ content, options });
      },
      async finalizeChapterContent({ content }) {
        return {
          finalContent: content,
          runtimePackage: createRuntimePackage(90),
        };
      },
      async markChapterGenerationState() {},
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    {
      autoReview: true,
      autoRepair: true,
    },
  );

  assert.equal(result.pass, true);
  assert.deepEqual(finalSyncs, [{
    content: "已有正文",
    options: {
      artifactSyncMode: "adaptive",
      contentProvenance: "confirmed",
    },
  }]);
});

test("runPipelineChapterWithRuntime passes debt provenance for retained failed content", async () => {
  const finalSyncs = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        return { content: "生成后的正文" };
      },
      async saveDraftAndArtifacts() {},
      async syncFinalChapterArtifacts(_novelId, _chapterId, content, options) {
        finalSyncs.push({ content, options });
      },
      async finalizeChapterContent({ content }) {
        return {
          finalContent: `${content}，保留但待复核。`,
          runtimePackage: createRuntimePackage(70),
        };
      },
      async markChapterGenerationState() {},
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    {
      autoReview: true,
      autoRepair: false,
    },
  );

  assert.equal(result.pass, false);
  assert.deepEqual(finalSyncs, [{
    content: "生成后的正文，保留但待复核。",
    options: {
      artifactSyncMode: "adaptive",
      contentProvenance: "debt",
    },
  }]);
  assert.deepEqual(result.qualityDebtAttribution.degradedProposalRouting, {
    contentProvenance: "debt",
    routedToPendingReview: true,
    proposalTypes: ["character_state_update", "character_resource_update"],
    fields: ["currentState", "currentGoal", "characterResource"],
  });
});

test("runPipelineChapterWithRuntime escalates patch failures to heavy repair and rechecks the chapter", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const stages = [];
  const savedDrafts = [];
  const finalSyncs = [];
  let needsRepairMarked = false;
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async () => ({
    output: {
      strategy: "patch_first",
      summary: "补足承接。",
      patches: [{
        id: "patch-missing",
        targetExcerpt: "模型认为存在但正文里没有的片段。",
        replacement: "替换后的片段。",
        reason: "目标片段不存在。",
        issueIds: [],
      }],
      requiresFullRewrite: false,
      escalationReason: null,
    },
  });
  promptRunner.setPromptRunnerLLMFactoryForTests(async () => ({
    invoke: async () => ({
      content: "rewritten chapter after safe full repair",
    }),
  }));

  try {
    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          return { content: "生成后的正文需要承接。" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState, options) {
          savedDrafts.push({ content, generationState, options });
        },
        async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
          finalSyncs.push(content);
        },
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          return {
            finalContent: content,
            runtimePackage: createRuntimePackage(reviewCount === 1 ? 72 : 90),
          };
        },
        async markChapterGenerationState() {},
        async markChapterNeedsRepair() {
          needsRepairMarked = true;
        },
      },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
      {
        async onStageChange(stage) {
          stages.push(stage);
        },
      },
    );

    assert.deepEqual(stages, ["generating_chapters", "reviewing", "repairing", "reviewing"]);
    assert.equal(reviewCount, 2);
    assert.equal(result.pass, true);
    assert.equal(result.retryCountUsed, 1);
    assert.equal(result.recoverableRepairFailure, null);
    assert.equal(needsRepairMarked, false);
    assert.equal(finalSyncs.length, 1);
    assert.deepEqual(savedDrafts, [{
      content: "生成后的正文需要承接。",
      generationState: "drafted",
      options: {
        scheduleBackgroundSync: false,
        artifactSyncMode: "adaptive",
        syncArtifacts: false,
      },
    }, {
      content: "rewritten chapter after safe full repair",
      generationState: "repaired",
      options: {
        scheduleBackgroundSync: false,
        artifactSyncMode: "adaptive",
        syncArtifacts: false,
      },
    }]);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
    promptRunner.setPromptRunnerLLMFactoryForTests();
  }
});

test("runPipelineChapterWithRuntime sends critical prose findings to repair and retains exhausted prose debt", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const stages = [];
  const savedDrafts = [];
  const finalSyncs = [];
  const finalizationCalls = [];
  const patchIssues = [];
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async (request) => {
    patchIssues.push(request.promptInput.issuesJson);
    return {
      output: {
        strategy: "patch_first",
        summary: "去掉模板化否定翻转。",
        patches: [{
          id: "patch-prose-negative-flip",
          targetExcerpt: "他不是害怕，而是终于明白自己不能回头。",
          replacement: "他握紧刀柄，指节发白，仍一步踏进雨里。",
          reason: "把抽象解释改成动作。",
          issueIds: [],
        }],
        requiresFullRewrite: false,
        escalationReason: null,
      },
    };
  };

  try {
    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          return { content: "他不是害怕，而是终于明白自己不能回头。" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState, options) {
          savedDrafts.push({ content, generationState, options });
        },
        async syncFinalChapterArtifacts(_novelId, _chapterId, content, options) {
          finalSyncs.push({ content, options });
        },
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          return {
            finalContent: content,
            runtimePackage: createProseRiskRuntimePackage(92),
          };
        },
        async finalizeChapterTimeline(input) {
          finalizationCalls.push(input);
        },
        async markChapterGenerationState() {},
        async markChapterNeedsRepair() {},
      },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
      {
        async onStageChange(stage) {
          stages.push(stage);
        },
      },
    );

    assert.deepEqual(stages, ["generating_chapters", "reviewing", "repairing", "reviewing"]);
    assert.equal(reviewCount, 2);
    assert.equal(result.retryCountUsed, 1);
    assert.equal(result.pass, false);
    assert.equal(result.runtimePackage.audit.openIssues[0].code, "prose_negative_flip");
    assert.match(patchIssues[0], /第 1 行/);
    assert.match(patchIssues[0], /模板化否定翻转/);
    assert.deepEqual(savedDrafts.map((item) => item.generationState), ["drafted", "repaired"]);
    assert.equal(finalSyncs[0].options.contentProvenance, "debt");
    assert.equal(finalizationCalls.length, 0);
    assert.deepEqual(result.qualityDebtAttribution.firstFailureIssueCodes, ["prose_negative_flip"]);
    assert.deepEqual(result.qualityDebtAttribution.secondFailureIssueCodes, ["prose_negative_flip"]);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
  }
});

test("runPipelineChapterWithRuntime escalates short patch targets to heavy repair", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const savedDrafts = [];
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async () => ({
    output: {
      strategy: "patch_first",
      summary: "尝试局部修文。",
      patches: [{
        id: "patch-short-target",
        targetExcerpt: "短",
        replacement: "替换后的安全句段。",
        reason: "模型给出了过短定位片段。",
        issueIds: [],
      }],
      requiresFullRewrite: false,
      escalationReason: null,
    },
  });
  promptRunner.setPromptRunnerLLMFactoryForTests(async () => ({
    invoke: async () => ({
      content: "rewritten chapter after short patch target",
    }),
  }));

  try {
    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          return { content: "生成后的正文需要承接。" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
          savedDrafts.push({ content, generationState });
        },
        async syncFinalChapterArtifacts() {},
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          return {
            finalContent: content,
            runtimePackage: createRuntimePackage(reviewCount === 1 ? 72 : 90),
          };
        },
        async markChapterGenerationState() {},
        async markChapterNeedsRepair() {},
      },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
    );

    assert.equal(reviewCount, 2);
    assert.equal(result.pass, true);
    assert.equal(result.retryCountUsed, 1);
    assert.equal(result.recoverableRepairFailure, null);
    assert.deepEqual(savedDrafts, [{
      content: "生成后的正文需要承接。",
      generationState: "drafted",
    }, {
      content: "rewritten chapter after short patch target",
      generationState: "repaired",
    }]);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
    promptRunner.setPromptRunnerLLMFactoryForTests();
  }
});

test("runPipelineChapterWithRuntime defers acceptance gate unavailable risk without local patch prompt", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const stages = [];
  const savedDrafts = [];
  const needsRepairMarked = [];
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async () => {
    throw new Error("patch repair should not run for acceptance gate unavailable risk");
  };
  promptRunner.setPromptRunnerLLMFactoryForTests(async () => ({
    invoke: async () => {
      throw new Error("heavy repair should not run for acceptance gate unavailable risk");
    },
  }));

  try {
    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          return { content: "生成后的正文可保留。" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
          savedDrafts.push({ content, generationState });
        },
        async syncFinalChapterArtifacts() {},
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          return {
            finalContent: content,
            runtimePackage: createAcceptanceGateUnavailableRuntimePackage(72),
          };
        },
        async markChapterGenerationState() {},
        async markChapterNeedsRepair(chapterId) {
          needsRepairMarked.push(chapterId);
        },
      },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
      {
        async onStageChange(stage) {
          stages.push(stage);
        },
      },
    );

    // 闸门不可用短路：不进入 repairDraftContent，故 stage 无 repairing
    assert.deepEqual(stages, ["generating_chapters", "reviewing"]);
    assert.equal(reviewCount, 1);
    assert.equal(result.pass, false);
    assert.equal(result.retryCountUsed, 0);
    assert.equal(result.recoverableRepairFailure.message, "章节接收判断暂时不可用，正文已保留，后续需要重新审校或人工复查。");
    assert.deepEqual(result.recoverableRepairFailure.failureTypes, ["review_gate_unavailable"]);
    assert.deepEqual(needsRepairMarked, ["chapter-1"]);
    assert.deepEqual(savedDrafts, [{
      content: "生成后的正文可保留。",
      generationState: "drafted",
    }]);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
    promptRunner.setPromptRunnerLLMFactoryForTests();
  }
});

test("runPipelineChapterWithRuntime forces full rewrite when style source entities leak", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const stages = [];
  const savedDrafts = [];
  let patchRepairCalled = false;
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async () => {
    patchRepairCalled = true;
    throw new Error("patch repair should not run for style source leakage");
  };
  promptRunner.setPromptRunnerLLMFactoryForTests(async () => ({
    invoke: async () => ({
      content: "clean rewritten chapter with transferable pacing only",
    }),
  }));

  try {
    const styleContext = {
      sanitizedGenerationProfile: {
        writingGuidance: ["keep fast scene turns without copying source entities"],
        forbiddenEntities: ["北凉王世子"],
        sourceProfileNames: ["source style"],
        sanitizedAt: "2026-05-01T00:00:00.000Z",
        strategy: "deterministic",
      },
    };

    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "test novel" },
            chapter: {
              id: "chapter-1",
              title: "chapter one",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: { styleContext },
          };
        },
        async generateDraftFromWriter() {
          return { content: "北凉王世子踏进城门，所有人都屏住呼吸。" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
          savedDrafts.push({ content, generationState });
        },
        async syncFinalChapterArtifacts() {},
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          return {
            finalContent: content,
            runtimePackage: createRuntimePackage(92, { styleContext }),
          };
        },
        async markChapterGenerationState() {},
        async markChapterNeedsRepair() {},
      },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
      {
        async onStageChange(stage) {
          stages.push(stage);
        },
      },
    );

    assert.equal(patchRepairCalled, false);
    assert.deepEqual(stages, ["generating_chapters", "reviewing", "repairing", "reviewing"]);
    assert.equal(reviewCount, 2);
    assert.equal(result.pass, true);
    assert.equal(result.retryCountUsed, 1);
    assert.deepEqual(savedDrafts, [{
      content: "北凉王世子踏进城门，所有人都屏住呼吸。",
      generationState: "drafted",
    }, {
      content: "clean rewritten chapter with transferable pacing only",
      generationState: "repaired",
    }]);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
    promptRunner.setPromptRunnerLLMFactoryForTests();
  }
});

test("runPipelineChapterWithRuntime does not save a generated draft twice when writer already synced artifacts", async () => {
  const savedDrafts = [];
  const finalSyncs = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "test novel" },
          chapter: {
            id: "chapter-1",
            title: "chapter one",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        return { content: "generated draft", artifactsAlreadySynced: true };
      },
      async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
        savedDrafts.push({ content, generationState });
      },
      async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
        finalSyncs.push(content);
      },
      async finalizeChapterContent({ content }) {
        return {
          finalContent: content,
          runtimePackage: createRuntimePackage(90),
        };
      },
      async markChapterGenerationState() {},
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    {
      autoReview: true,
      autoRepair: true,
    },
  );

  assert.deepEqual(savedDrafts, []);
  assert.deepEqual(finalSyncs, ["generated draft"]);
  assert.equal(result.pass, true);
  assert.equal(result.reviewExecuted, true);
});

test("runPipelineChapterWithRuntime does not resave unchanged existing chapter content as a draft", async () => {
  const stages = [];
  const savedDrafts = [];
  const finalSyncs = [];
  const generationStates = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "test novel" },
          chapter: {
            id: "chapter-1",
            title: "chapter one",
            order: 1,
            content: "existing reviewed content",
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        throw new Error("existing content should not be regenerated");
      },
      async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
        savedDrafts.push({ content, generationState });
      },
      async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
        finalSyncs.push(content);
      },
      async finalizeChapterContent({ content }) {
        return {
          finalContent: content,
          runtimePackage: createRuntimePackage(90),
        };
      },
      async markChapterGenerationState(_chapterId, generationState) {
        generationStates.push(generationState);
      },
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    {
      autoReview: true,
      autoRepair: true,
    },
    {
      async onStageChange(stage) {
        stages.push(stage);
      },
    },
  );

  assert.deepEqual(stages, ["reviewing"]);
  assert.deepEqual(savedDrafts, []);
  assert.deepEqual(finalSyncs, ["existing reviewed content"]);
  assert.deepEqual(generationStates, ["reviewed", "approved"]);
  assert.equal(result.pass, true);
});

test("runPipelineChapterWithRuntime retries once when writer returns empty content", async () => {
  const stages = [];
  const emptyEvents = [];
  const savedDrafts = [];
  let generationCount = 0;

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        generationCount += 1;
        return { content: generationCount === 1 ? "   " : "重试后的正文" };
      },
      async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
        savedDrafts.push({ content, generationState });
      },
      async syncFinalChapterArtifacts() {},
      async finalizeChapterContent({ content }) {
        return {
          finalContent: content,
          runtimePackage: createRuntimePackage(90),
        };
      },
      async markChapterGenerationState() {},
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    {
      autoReview: true,
      autoRepair: true,
    },
    {
      async onStageChange(stage) {
        stages.push(stage);
      },
      async onEmptyContent(event) {
        emptyEvents.push({
          attempt: event.attempt,
          willRetry: event.willRetry,
          contentLength: event.contentLength,
        });
      },
    },
  );

  assert.equal(generationCount, 2);
  assert.deepEqual(stages, ["generating_chapters", "generating_chapters", "reviewing"]);
  assert.deepEqual(emptyEvents, [{ attempt: 1, willRetry: true, contentLength: 0 }]);
  assert.deepEqual(savedDrafts, [{
    content: "重试后的正文",
    generationState: "drafted",
  }]);
  assert.equal(result.pass, true);
});

test("runPipelineChapterWithRuntime fails empty writer output without saving or advancing state", async () => {
  const emptyEvents = [];
  const savedDrafts = [];
  const generationStates = [];
  let generationCount = 0;

  await assert.rejects(
    () => runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          generationCount += 1;
          return { content: generationCount === 1 ? "" : "\n\n" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
          savedDrafts.push({ content, generationState });
        },
        async syncFinalChapterArtifacts() {},
        async finalizeChapterContent() {
          throw new Error("empty drafts should not be reviewed");
        },
        async markChapterGenerationState(_chapterId, generationState) {
          generationStates.push(generationState);
        },
        async markChapterNeedsRepair() {},
      },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
      {
        async onEmptyContent(event) {
          emptyEvents.push({
            attempt: event.attempt,
            willRetry: event.willRetry,
            contentLength: event.contentLength,
          });
        },
      },
    ),
    ChapterEmptyContentError,
  );

  assert.equal(generationCount, 2);
  assert.deepEqual(emptyEvents, [
    { attempt: 1, willRetry: true, contentLength: 0 },
    { attempt: 2, willRetry: false, contentLength: 0 },
  ]);
  assert.deepEqual(savedDrafts, []);
  assert.deepEqual(generationStates, []);
});

test("runPipelineChapterWithRuntime retries mid-stream transport failure then succeeds", async () => {
  const stages = [];
  const transportEvents = [];
  const savedDrafts = [];
  let generationCount = 0;

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        generationCount += 1;
        if (generationCount === 1) {
          throw new Error("fetch failed: ECONNRESET");
        }
        return { content: "传输重试后的正文" };
      },
      async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
        savedDrafts.push({ content, generationState });
      },
      async syncFinalChapterArtifacts() {},
      async finalizeChapterContent({ content }) {
        return {
          finalContent: content,
          runtimePackage: createRuntimePackage(90),
        };
      },
      async markChapterGenerationState() {},
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    {
      autoReview: true,
      autoRepair: true,
    },
    {
      async onStageChange(stage) {
        stages.push(stage);
      },
      async onWriterTransportRetry(event) {
        transportEvents.push({
          attempt: event.attempt,
          willRetry: event.willRetry,
          message: event.message,
        });
      },
    },
  );

  assert.equal(generationCount, 2);
  assert.deepEqual(stages, ["generating_chapters", "generating_chapters", "reviewing"]);
  assert.equal(transportEvents.length, 1);
  assert.equal(transportEvents[0].attempt, 1);
  assert.equal(transportEvents[0].willRetry, true);
  assert.match(transportEvents[0].message, /ECONNRESET|fetch failed/);
  assert.deepEqual(savedDrafts, [{
    content: "传输重试后的正文",
    generationState: "drafted",
  }]);
  assert.equal(result.pass, true);
});

test("runPipelineChapterWithRuntime does not retry non-transient writer errors", async () => {
  let generationCount = 0;
  const transportEvents = [];

  await assert.rejects(
    () => runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          generationCount += 1;
          throw new Error("provider rejected: invalid_api_key");
        },
        async saveDraftAndArtifacts() {
          throw new Error("should not save");
        },
        async syncFinalChapterArtifacts() {},
        async finalizeChapterContent() {
          throw new Error("should not finalize");
        },
        async markChapterGenerationState() {},
        async markChapterNeedsRepair() {},
      },
      "novel-1",
      "chapter-1",
      { autoReview: true, autoRepair: true },
      {
        async onWriterTransportRetry(event) {
          transportEvents.push(event);
        },
      },
    ),
    /invalid_api_key/,
  );

  assert.equal(generationCount, 1);
  assert.deepEqual(transportEvents, []);
});

test("runPipelineChapterWithRuntime defaults to a single repair pass before stopping", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const stages = [];
  const finalizeInputs = [];
  const savedDrafts = [];
  const finalSyncs = [];
  const generationStates = [];
  const finalizationCalls = [];
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async () => ({
    output: {
      strategy: "patch_first",
      summary: "补足承接。",
      patches: [{
        id: "patch-1",
        targetExcerpt: "初审正文需要承接。",
        replacement: "修后正文补足承接。",
        reason: "补足承接。",
        issueIds: [],
      }],
      requiresFullRewrite: false,
      escalationReason: null,
    },
  });

  try {
    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          return { content: "生成后的正文" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
          savedDrafts.push({ content, generationState });
        },
        async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
          finalSyncs.push(content);
        },
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          finalizeInputs.push(content);
          return {
            finalContent: reviewCount === 1 ? "初审正文需要承接。" : "修后复审正文",
            runtimePackage: createRuntimePackage(reviewCount === 1 ? 72 : 73),
          };
        },
        async finalizeChapterTimeline(input) {
          finalizationCalls.push(input);
        },
        async markChapterGenerationState(_chapterId, generationState) {
          generationStates.push(generationState);
        },
        async markChapterNeedsRepair() {},
      },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
      {
        async onStageChange(stage) {
          stages.push(stage);
        },
      },
    );

    assert.deepEqual(stages, ["generating_chapters", "reviewing", "repairing", "reviewing"]);
    assert.deepEqual(finalizeInputs, ["生成后的正文", "修后正文补足承接。"]);
    assert.equal(reviewCount, 2);
    assert.equal(result.retryCountUsed, 1);
    assert.equal(result.pass, false);
    assert.deepEqual(generationStates, ["reviewed", "reviewed"]);
    assert.deepEqual(savedDrafts, [
      {
        content: "生成后的正文",
        generationState: "drafted",
      },
      {
        content: "修后正文补足承接。",
        generationState: "repaired",
      },
    ]);
    assert.equal(finalSyncs.length, 1);
    assert.equal(finalizationCalls.length, 0);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
  }
});

test("runPipelineChapterWithRuntime clamps maxRetries to a single repair pass", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const stages = [];
  const finalizeInputs = [];
  const savedDrafts = [];
  const finalSyncs = [];
  const generationStates = [];
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async () => ({
    output: {
      strategy: "patch_first",
      summary: "补足承接。",
      patches: [{
        id: "patch-1",
        targetExcerpt: "初审正文需要承接。",
        replacement: "修后正文补足承接。",
        reason: "补足承接。",
        issueIds: [],
      }],
      requiresFullRewrite: false,
      escalationReason: null,
    },
  });

  try {
    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          return { content: "生成后的正文" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState, options) {
          savedDrafts.push({ content, generationState, options });
        },
        async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
          finalSyncs.push(content);
        },
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          finalizeInputs.push(content);
          return {
            finalContent: reviewCount === 1 ? "初审正文需要承接。" : "修后复审正文",
            runtimePackage: createRuntimePackage(reviewCount === 1 ? 72 : 73),
          };
        },
        async markChapterGenerationState(_chapterId, generationState) {
          generationStates.push(generationState);
        },
        async markChapterNeedsRepair() {},
      },
      "novel-1",
      "chapter-1",
      {
        maxRetries: 5,
        autoReview: true,
        autoRepair: true,
      },
      {
        async onStageChange(stage) {
          stages.push(stage);
        },
      },
    );

    assert.deepEqual(stages, ["generating_chapters", "reviewing", "repairing", "reviewing"]);
    assert.deepEqual(finalizeInputs, ["生成后的正文", "修后正文补足承接。"]);
    assert.equal(reviewCount, 2);
    assert.equal(result.retryCountUsed, 1);
    assert.equal(result.pass, false);
    assert.deepEqual(generationStates, ["reviewed", "reviewed"]);
    assert.deepEqual(savedDrafts, [
      {
        content: "生成后的正文",
        generationState: "drafted",
        options: {
          scheduleBackgroundSync: false,
          artifactSyncMode: "adaptive",
          syncArtifacts: false,
        },
      },
      {
        content: "修后正文补足承接。",
        generationState: "repaired",
        options: {
          scheduleBackgroundSync: false,
          artifactSyncMode: "adaptive",
          syncArtifacts: false,
        },
      },
    ]);
    assert.equal(finalSyncs.length, 1);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
  }
});


// ─── Dual-gate wiring contract (styleClear × literaryPass → chapterStatus) ───
// 捕获 markChapterGenerationState 的 options，经 mergeChapterPatchForGenerationStateBump
// 投影运营状态。若 adapter/caller 丢弃第 3 参，completed 会假绿。

function captureDualGateDeps(runtimePackageFactory) {
  const marks = [];
  return {
    marks,
    deps: {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: "已有正文",
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        throw new Error("existing content should not be regenerated");
      },
      async saveDraftAndArtifacts() {},
      async syncFinalChapterArtifacts() {},
      async finalizeChapterContent({ content }) {
        return {
          finalContent: content,
          runtimePackage: runtimePackageFactory(),
        };
      },
      async markChapterGenerationState(_chapterId, generationState, options) {
        marks.push({ generationState, options: options ?? null });
      },
      async markChapterNeedsRepair() {},
    },
  };
}

function projectedStatusFromMarks(marks) {
  // 模拟 adapter：把 options 传给 mergeChapterPatchForGenerationStateBump
  let patch = {};
  for (const mark of marks) {
    patch = mergeChapterPatchForGenerationStateBump(
      patch,
      mark.generationState,
      mark.options ?? undefined,
    );
  }
  return patch;
}

test("dual-gate wiring: literaryPass+styleClear true → completed", async () => {
  const { marks, deps } = captureDualGateDeps(() => createDualGatePassPackage());
  const result = await runPipelineChapterWithRuntime(
    deps,
    "novel-1",
    "chapter-1",
    { autoReview: true, autoRepair: true },
  );
  assert.equal(result.pass, true);
  const approved = marks.find((m) => m.generationState === "approved");
  assert.ok(approved, "must mark approved");
  assert.deepEqual(approved.options, { literaryPass: true, styleClear: true });
  assert.deepEqual(projectedStatusFromMarks(marks), {
    generationState: "approved",
    chapterStatus: "completed",
  });
});

test("dual-gate wiring: open-chapter residual hard → styleClear false → needs_repair", async () => {
  const { marks, deps } = captureDualGateDeps(() => createDualGatePassPackage({
    chapter: { order: 1 },
    styleReview: {
      autoRewritten: true,
      report: {
        riskScore: 55,
        summary: "entry",
        canAutoRewrite: true,
        appliedRuleIds: [],
        violations: [],
      },
      residualReport: {
        riskScore: 50,
        summary: "residual high on open chapter",
        canAutoRewrite: true,
        appliedRuleIds: [],
        violations: [],
      },
    },
  }));
  const result = await runPipelineChapterWithRuntime(
    deps,
    "novel-1",
    "chapter-1",
    { autoReview: true, autoRepair: true },
  );
  // 文学分仍过 → pipeline pass=true，但 styleClear 应 false → 不得 completed
  assert.equal(result.pass, true);
  const approved = marks.find((m) => m.generationState === "approved");
  assert.ok(approved);
  assert.equal(approved.options?.literaryPass, true);
  assert.equal(approved.options?.styleClear, false);
  assert.deepEqual(projectedStatusFromMarks(marks), {
    generationState: "reviewed",
    chapterStatus: "needs_repair",
  });
});

test("dual-gate wiring: blocking pronoun L0 → styleClear false → needs_repair", async () => {
  const { marks, deps } = captureDualGateDeps(() => createDualGatePassPackage({
    chapter: { order: 40 },
    openIssues: [{
      auditType: "mode_fit",
      severity: "medium",
      evidence: "他走到窗边。他坐下。他端杯。他沉默。",
      fixSuggestion: "改用专名起句",
      code: "prose_pronoun_subject_stack",
    }],
    hasBlockingIssues: false,
    styleReview: {
      autoRewritten: false,
      report: {
        riskScore: 10,
        summary: "",
        canAutoRewrite: false,
        appliedRuleIds: ["l0:prose_pronoun_subject_stack"],
        violations: [],
      },
      residualReport: {
        riskScore: 10,
        summary: "",
        canAutoRewrite: false,
        appliedRuleIds: [],
        violations: [],
      },
    },
  }));
  const result = await runPipelineChapterWithRuntime(
    deps,
    "novel-1",
    "chapter-1",
    { autoReview: true, autoRepair: true },
  );
  assert.equal(result.pass, true);
  const approved = marks.find((m) => m.generationState === "approved");
  assert.ok(approved);
  assert.equal(approved.options?.literaryPass, true);
  assert.equal(approved.options?.styleClear, false);
  assert.deepEqual(projectedStatusFromMarks(marks), {
    generationState: "reviewed",
    chapterStatus: "needs_repair",
  });
});

test("dual-gate wiring: omit literaryPass (autoReview=false) never projects completed", async () => {
  const marks = [];
  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        return { content: "生成后的正文" };
      },
      async saveDraftAndArtifacts() {},
      async syncFinalChapterArtifacts() {},
      async finalizeChapterContent() {
        throw new Error("should not finalize when autoReview=false");
      },
      async markChapterGenerationState(_chapterId, generationState, options) {
        marks.push({ generationState, options: options ?? null });
      },
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    { autoReview: false, autoRepair: true },
  );
  assert.equal(result.pass, true);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].generationState, "approved");
  // 跳过审校：不传 literaryPass → merge 只 bump generationState
  assert.equal(marks[0].options, null);
  assert.deepEqual(projectedStatusFromMarks(marks), {
    generationState: "approved",
  });
  assert.notEqual(projectedStatusFromMarks(marks).chapterStatus, "completed");
});

test("dual-gate wiring: ChapterPipelineRuntimeAdapter forwards options to merge", () => {
  // 源码契约：adapter 绑定必须把第 3 参 options 透传；丢弃则生产 completed 假绿。
  const adapterSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/runtime/ChapterPipelineRuntimeAdapter.ts"),
    "utf8",
  );
  assert.match(
    adapterSrc,
    /markChapterGenerationState:\s*\(\s*targetChapterId\s*,\s*generationState\s*,\s*options\s*\)\s*=>/,
  );
  assert.match(
    adapterSrc,
    /this\.markChapterGenerationState\(\s*targetChapterId\s*,\s*generationState\s*,\s*options\s*\)/,
  );
  // 禁止两参闭包丢弃 options（回归 guard）
  assert.doesNotMatch(
    adapterSrc,
    /markChapterGenerationState:\s*\(\s*targetChapterId\s*,\s*generationState\s*\)\s*=>\s*\s*this\.markChapterGenerationState\(\s*targetChapterId\s*,\s*generationState\s*\)/,
  );
});


test("open-chapter rewrite paths forward chapterOrder into style contract", () => {
  // P2：改写与合同路径须把 chapterOrder 传给 buildWriterStyleContractText，
  // 否则开篇声线提示只在 writer 首写生效、rewrite 丢失。
  const rewriteSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/styleEngine/StyleRewriteService.ts"),
    "utf8",
  );
  assert.match(rewriteSrc, /chapterOrder\?:\s*number\s*\|\s*null/);
  assert.match(
    rewriteSrc,
    /buildWriterStyleContractText\([\s\S]*?chapterOrder:\s*input\.chapterOrder/,
  );

  const reviewSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/runtime/PostGenerationStyleReviewRunner.ts"),
    "utf8",
  );
  assert.match(
    reviewSrc,
    /chapterOrder:\s*input\.contextPackage\?\.chapter\?\.order\s*\?\?\s*null/,
  );

  const contractSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/volume/ChapterExecutionContractService.ts"),
    "utf8",
  );
  assert.match(
    contractSrc,
    /buildWriterStyleContractText\(\s*[\s\S]*?\{\s*chapterOrder\s*\}/,
  );
});

