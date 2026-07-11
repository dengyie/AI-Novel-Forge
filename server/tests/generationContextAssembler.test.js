const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GenerationContextAssembler,
  buildBlockingPendingReviewProposalWhere,
  resolveChapterResourceCharacterIds,
} = require("../dist/services/novel/runtime/GenerationContextAssembler.js");
const { prisma } = require("../dist/db/prisma.js");
const { plannerService } = require("../dist/services/planner/PlannerService.js");
const { contextAssemblyService } = require("../dist/services/novel/production/ContextAssemblyService.js");
const { ragServices } = require("../dist/services/rag/index.js");
const { novelReferenceService } = require("../dist/services/novel/NovelReferenceService.js");
const { characterDynamicsQueryService } = require("../dist/services/novel/dynamics/CharacterDynamicsQueryService.js");
const { payoffLedgerSyncService } = require("../dist/services/payoff/PayoffLedgerSyncService.js");
const { characterResourceLedgerService } = require("../dist/services/novel/characterResource/CharacterResourceLedgerService.js");

test("blocking pending-review proposals are scoped to the current chapter plus global proposals", () => {
  const where = buildBlockingPendingReviewProposalWhere("novel-1", "chapter-2");

  assert.deepEqual(where, {
    novelId: "novel-1",
    status: "pending_review",
    OR: [
      { chapterId: "chapter-2" },
      { chapterId: null },
    ],
  });
});

test("chapter resource character ids are resolved from plan participant names", () => {
  const now = new Date();
  const ids = resolveChapterResourceCharacterIds({
    plan: {
      participantsJson: JSON.stringify(["女二", "主角"]),
      scenes: [],
      createdAt: now,
      updatedAt: now,
    },
    characters: [
      { id: "char-1", name: "主角" },
      { id: "char-2", name: "女二" },
      { id: "char-3", name: "路人" },
    ],
  });

  assert.deepEqual(ids, ["char-1", "char-2"]);
});

function createSceneCards(prefix) {
  return JSON.stringify({
    targetWordCount: 3000,
    lengthBudget: {
      targetWordCount: 3000,
      softMinWordCount: 2550,
      softMaxWordCount: 3450,
      hardMaxWordCount: 3750,
    },
    scenes: [1, 2, 3].map((index) => ({
      key: `${prefix}-${index}`,
      title: `${prefix}场景${index}`,
      purpose: `${prefix}场景${index}目标`,
      mustAdvance: [`${prefix}推进${index}`],
      mustPreserve: [`${prefix}保留${index}`],
      entryState: `${prefix}入口${index}`,
      exitState: `${prefix}出口${index}`,
      forbiddenExpansion: [`${prefix}禁止扩展${index}`],
      targetWordCount: 1000,
    })),
  });
}

function createCanonicalSnapshot() {
  const now = new Date().toISOString();
  return {
    novelId: "novel-1",
    sourceSnapshotId: null,
    scopeLabel: "chapter",
    bookContract: {
      title: "测试小说",
      genre: "玄幻",
      targetAudience: null,
      sellingPoint: null,
      first30ChapterPromise: null,
      toneGuardrails: [],
      hardConstraints: [],
    },
    worldState: null,
    characters: [],
    narrative: {
      currentChapterId: "chapter-1",
      currentChapterOrder: 1,
      currentChapterGoal: "写当前章",
      openConflicts: [],
      pendingPayoffs: [],
      urgentPayoffs: [],
      overduePayoffs: [],
      publicKnowledge: [],
      hiddenKnowledge: [],
      suspenseThreads: [],
    },
    timeline: [],
    createdAt: now,
  };
}

function createStoryWorldSlice() {
  return {
    storyId: "novel-1",
    worldId: "world-slice-1",
    coreWorldFrame: "星核枯竭的北境舞台。",
    appliedRules: [{
      id: "rule-star-core",
      name: "星核代价",
      summary: "透支星核会损伤寿命。",
      whyItMatters: "能力不能无代价升级。",
    }],
    activeForces: [],
    activeLocations: [],
    activeElements: [],
    conflictCandidates: [],
    pressureSources: [],
    mysterySources: [],
    suggestedStoryAxes: [],
    recommendedEntryPoints: [],
    forbiddenCombinations: ["不要把星核写成普通灵石"],
    storyScopeBoundary: "前期限定在北境。",
    metadata: {
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      sourceWorldUpdatedAt: null,
      storyInputDigest: "digest",
      builtFromStructuredData: true,
      builderMode: "runtime",
    },
  };
}

test("assembler refreshes chapter execution fields after chapter plan regeneration", async () => {
  const staleSceneCards = createSceneCards("旧合同");
  const freshSceneCards = createSceneCards("新合同");
  const now = new Date();
  let chapterFindFirstCalls = 0;

  const originals = {
    novelFindUnique: prisma.novel.findUnique,
    chapterFindFirst: prisma.chapter.findFirst,
    stateChangeProposalCount: prisma.stateChangeProposal.count,
    stateChangeProposalFindMany: prisma.stateChangeProposal.findMany,
    auditIssueFindMany: prisma.auditIssue.findMany,
    novelBibleFindUnique: prisma.novelBible.findUnique,
    chapterSummaryFindMany: prisma.chapterSummary.findMany,
    consistencyFactFindMany: prisma.consistencyFact.findMany,
    chapterFindMany: prisma.chapter.findMany,
    creativeDecisionFindMany: prisma.creativeDecision.findMany,
    ensureChapterPlan: plannerService.ensureChapterPlan,
    buildPlanPromptBlock: plannerService.buildPlanPromptBlock,
    buildStateContext: contextAssemblyService.build,
    buildReferenceForStage: novelReferenceService.buildReferenceForStage,
    getCharacterDynamics: characterDynamicsQueryService.getOverview,
    buildRagContext: ragServices.hybridRetrievalService.buildContextBlock,
    getPayoffLedger: payoffLedgerSyncService.getPayoffLedger,
    buildCharacterResourceContext: characterResourceLedgerService.buildContext,
  };

  try {
    prisma.novel.findUnique = async () => ({
      id: "novel-1",
      title: "测试小说",
      world: null,
      genre: { name: "玄幻" },
      characters: [],
      storyMacroPlan: null,
      volumePlans: [],
      primaryStoryMode: null,
      secondaryStoryMode: null,
      targetAudience: null,
      bookSellingPoint: null,
      first30ChapterPromise: null,
      narrativePov: null,
      pacePreference: null,
      emotionIntensity: null,
      styleTone: null,
      outline: null,
      structuredOutline: null,
    });
    prisma.chapter.findFirst = async () => {
      chapterFindFirstCalls += 1;
      return {
        id: "chapter-1",
        title: "第1章",
        order: 1,
        content: null,
        expectation: chapterFindFirstCalls === 1 ? "旧目标" : "新目标",
        targetWordCount: 3000,
        conflictLevel: 2,
        revealLevel: 1,
        mustAvoid: chapterFindFirstCalls === 1 ? "旧禁止" : "新禁止",
        taskSheet: chapterFindFirstCalls === 1 ? "旧任务单" : "新任务单",
        sceneCards: chapterFindFirstCalls === 1 ? staleSceneCards : freshSceneCards,
        hook: chapterFindFirstCalls === 1 ? "旧钩子" : "新钩子",
      };
    };
    prisma.stateChangeProposal.count = async () => 0;
    prisma.stateChangeProposal.findMany = async () => [];
    prisma.auditIssue.findMany = async () => [];
    prisma.novelBible.findUnique = async () => null;
    prisma.chapterSummary.findMany = async () => [];
    prisma.consistencyFact.findMany = async () => [];
    prisma.chapter.findMany = async () => [];
    prisma.creativeDecision.findMany = async () => [];
    plannerService.ensureChapterPlan = async () => ({
      id: "plan-1",
      chapterId: "chapter-1",
      planRole: "pressure",
      phaseLabel: "起点",
      title: "计划",
      objective: "新目标",
      participantsJson: "[]",
      revealsJson: "[]",
      riskNotesJson: "[]",
      mustAdvanceJson: "[]",
      mustPreserveJson: "[]",
      sourceIssueIdsJson: "[]",
      replannedFromPlanId: null,
      hookTarget: "新钩子",
      rawPlanJson: null,
      scenes: [],
      createdAt: now,
      updatedAt: now,
    });
    plannerService.buildPlanPromptBlock = async () => "";
    contextAssemblyService.build = async () => ({
      snapshot: createCanonicalSnapshot(),
      nextAction: "write_chapter",
      chapterStateGoal: null,
      protectedSecrets: [],
    });
    novelReferenceService.buildReferenceForStage = async () => "";
    characterDynamicsQueryService.getOverview = async () => null;
    ragServices.hybridRetrievalService.buildContextBlock = async () => "";
    payoffLedgerSyncService.getPayoffLedger = async () => ({ items: [] });
    characterResourceLedgerService.buildContext = async () => null;

    const assembler = new GenerationContextAssembler();
    const storyWorldSlice = createStoryWorldSlice();
    assembler.worldContextGateway = {
      getWorldContextBlock: async (id, options) => {
        assert.equal(id, "novel-1");
        assert.deepEqual(options, { purpose: "chapter" });
        return {
          promptBlock: "【本书世界上下文｜用途：chapter】\n星核枯竭的北境舞台。",
          rawSlice: storyWorldSlice,
        };
      },
    };
    assembler.continuationService = {
      buildChapterContextPack: async () => ({
        enabled: false,
        sourceType: null,
        sourceId: null,
        sourceTitle: null,
        systemRule: "",
        humanBlock: "",
        antiCopyCorpus: [],
      }),
    };
    assembler.styleBindingService = {
      resolveForGeneration: async () => ({
        matchedBindings: [],
        compiledBlocks: null,
        effectiveStyleProfileId: null,
        taskStyleProfileId: null,
        activeSourceTargets: [],
        activeSourceLabels: [],
        globalAntiAiRuleIds: [],
        styleAntiAiRuleIds: [],
        sanitizedGenerationProfile: null,
      }),
    };

    const assembled = await assembler.assemble("novel-1", "chapter-1", {});

    assert.equal(chapterFindFirstCalls, 2);
    assert.equal(assembled.chapter.taskSheet, "新任务单");
    assert.equal(assembled.contextPackage.chapter.sceneCards, freshSceneCards);
    assert.equal(assembled.contextPackage.storyWorldSlice, storyWorldSlice);
    assert.match(assembled.contextPackage.chapter.supportingContextText, /本书世界上下文/);
    assert.match(assembled.contextPackage.chapter.supportingContextText, /星核枯竭的北境舞台/);
    assert.equal(assembled.contextPackage.chapterWriteContext.chapterBoundary.entryState, "新合同入口1");
    assert.ok(assembled.contextPackage.chapterWriteContext.chapterBoundary.doNotCross.includes("新禁止"));
  } finally {
    prisma.novel.findUnique = originals.novelFindUnique;
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.stateChangeProposal.count = originals.stateChangeProposalCount;
    prisma.stateChangeProposal.findMany = originals.stateChangeProposalFindMany;
    prisma.auditIssue.findMany = originals.auditIssueFindMany;
    prisma.novelBible.findUnique = originals.novelBibleFindUnique;
    prisma.chapterSummary.findMany = originals.chapterSummaryFindMany;
    prisma.consistencyFact.findMany = originals.consistencyFactFindMany;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.creativeDecision.findMany = originals.creativeDecisionFindMany;
    plannerService.ensureChapterPlan = originals.ensureChapterPlan;
    plannerService.buildPlanPromptBlock = originals.buildPlanPromptBlock;
    contextAssemblyService.build = originals.buildStateContext;
    novelReferenceService.buildReferenceForStage = originals.buildReferenceForStage;
    characterDynamicsQueryService.getOverview = originals.getCharacterDynamics;
    ragServices.hybridRetrievalService.buildContextBlock = originals.buildRagContext;
    payoffLedgerSyncService.getPayoffLedger = originals.getPayoffLedger;
    characterResourceLedgerService.buildContext = originals.buildCharacterResourceContext;
  }
});

test("assembler injects sceneDiversityForce from prior-chapter lookback when texts are near-duplicate", async () => {
  const now = new Date();
  const repeatedBlob = "城门逃亡雨夜追兵压迫再逃亡";
  const originals = {
    novelFindUnique: prisma.novel.findUnique,
    chapterFindFirst: prisma.chapter.findFirst,
    stateChangeProposalCount: prisma.stateChangeProposal.count,
    stateChangeProposalFindMany: prisma.stateChangeProposal.findMany,
    auditIssueFindMany: prisma.auditIssue.findMany,
    novelBibleFindUnique: prisma.novelBible.findUnique,
    chapterSummaryFindMany: prisma.chapterSummary.findMany,
    consistencyFactFindMany: prisma.consistencyFact.findMany,
    chapterFindMany: prisma.chapter.findMany,
    creativeDecisionFindMany: prisma.creativeDecision.findMany,
    ensureChapterPlan: plannerService.ensureChapterPlan,
    buildPlanPromptBlock: plannerService.buildPlanPromptBlock,
    buildStateContext: contextAssemblyService.build,
    buildReferenceForStage: novelReferenceService.buildReferenceForStage,
    getCharacterDynamics: characterDynamicsQueryService.getOverview,
    buildRagContext: ragServices.hybridRetrievalService.buildContextBlock,
    getPayoffLedger: payoffLedgerSyncService.getPayoffLedger,
    buildCharacterResourceContext: characterResourceLedgerService.buildContext,
  };

  try {
    prisma.novel.findUnique = async () => ({
      id: "novel-1",
      title: "测试小说",
      world: null,
      genre: { name: "玄幻" },
      characters: [],
      storyMacroPlan: null,
      volumePlans: [],
      primaryStoryMode: null,
      secondaryStoryMode: null,
      targetAudience: null,
      bookSellingPoint: null,
      first30ChapterPromise: null,
      narrativePov: null,
      pacePreference: null,
      emotionIntensity: null,
      styleTone: null,
      outline: null,
      structuredOutline: null,
      estimatedChapterCount: 40,
    });
    prisma.chapter.findFirst = async () => ({
      id: "chapter-40",
      title: "第40章",
      order: 40,
      content: null,
      expectation: "换场景推进",
      targetWordCount: 2200,
      conflictLevel: 3,
      revealLevel: 2,
      mustAvoid: "旧禁止",
      taskSheet: "新任务单",
      sceneCards: createSceneCards("新合同"),
      hook: "钩子",
    });
    prisma.stateChangeProposal.count = async () => 0;
    prisma.stateChangeProposal.findMany = async () => [];
    prisma.auditIssue.findMany = async () => [];
    prisma.novelBible.findUnique = async () => null;
    prisma.chapterSummary.findMany = async () => [];
    prisma.consistencyFactFindMany = async () => [];
    prisma.creativeDecisionFindMany = async () => [];

    // Discriminate findMany by select shape: diversity uses taskSheet + chapterSummary; tail/opening use content.
    prisma.chapter.findMany = async (args = {}) => {
      const select = args.select || {};
      if (select.taskSheet || select.chapterSummary) {
        return [5, 4, 3, 2, 1].map((order) => ({
          order,
          title: `第${order}章逃亡`,
          taskSheet: repeatedBlob,
          chapterSummary: { summary: repeatedBlob },
        }));
      }
      if (select.content) {
        // opening compare / previous tail
        return [{
          order: 39,
          title: "第39章",
          content: "尾段内容用于 previousChapterTail。",
        }];
      }
      return [];
    };

    plannerService.ensureChapterPlan = async () => ({
      id: "plan-40",
      chapterId: "chapter-40",
      planRole: "pressure",
      phaseLabel: "中段",
      title: "计划",
      objective: "推进",
      participantsJson: "[]",
      revealsJson: "[]",
      riskNotesJson: JSON.stringify([
        "plan-risk-1", "plan-risk-2", "plan-risk-3", "plan-risk-4", "plan-risk-5",
      ]),
      mustAdvanceJson: "[]",
      mustPreserveJson: "[]",
      sourceIssueIdsJson: "[]",
      replannedFromPlanId: null,
      hookTarget: "钩子",
      rawPlanJson: null,
      scenes: [],
      createdAt: now,
      updatedAt: now,
    });
    plannerService.buildPlanPromptBlock = async () => "";
    contextAssemblyService.build = async () => ({
      snapshot: createCanonicalSnapshot(),
      nextAction: "write_chapter",
      chapterStateGoal: null,
      protectedSecrets: ["s1", "s2", "s3", "s4"],
    });
    novelReferenceService.buildReferenceForStage = async () => "";
    characterDynamicsQueryService.getOverview = async () => null;
    ragServices.hybridRetrievalService.buildContextBlock = async () => "";
    payoffLedgerSyncService.getPayoffLedger = async () => ({ items: [] });
    characterResourceLedgerService.buildContext = async () => null;

    const assembler = new GenerationContextAssembler();
    assembler.worldContextGateway = {
      getWorldContextBlock: async () => ({
        promptBlock: "世界上下文",
        rawSlice: null,
      }),
    };
    assembler.continuationService = {
      buildChapterContextPack: async () => ({
        enabled: false,
        sourceType: null,
        sourceId: null,
        sourceTitle: null,
        systemRule: "",
        humanBlock: "",
        antiCopyCorpus: [],
      }),
    };
    assembler.styleBindingService = {
      resolveForGeneration: async () => ({
        matchedBindings: [],
        compiledBlocks: null,
        effectiveStyleProfileId: null,
        taskStyleProfileId: null,
        activeSourceTargets: [],
        activeSourceLabels: [],
        globalAntiAiRuleIds: [],
        styleAntiAiRuleIds: [],
        sanitizedGenerationProfile: null,
      }),
    };

    const assembled = await assembler.assemble("novel-1", "chapter-40", {});
    const force = assembled.contextPackage.sceneDiversityForce;
    assert.ok(force, "sceneDiversityForce should be present when prior chapters are near-duplicate");
    assert.equal(force.shouldForce, true);
    assert.equal(force.advisory, true);
    assert.ok(force.riskNotes.some((item) => item.includes("scene_diversity_force")));
    assert.ok(
      assembled.contextPackage.chapterWriteContext.chapterMission.riskNotes.some(
        (item) => item.includes("scene_diversity_force"),
      ),
      "force note must survive plan/secrets volume on write context",
    );
    assert.ok(
      assembled.contextPackage.chapterWriteContext.recentScenePatterns.length > 0,
    );
    // soft only: must not pollute hard boundary
    assert.ok(
      !assembled.contextPackage.chapterWriteContext.chapterBoundary.doNotCross.some(
        (item) => item.includes("scene_diversity_force"),
      ),
    );
  } finally {
    prisma.novel.findUnique = originals.novelFindUnique;
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.stateChangeProposal.count = originals.stateChangeProposalCount;
    prisma.stateChangeProposal.findMany = originals.stateChangeProposalFindMany;
    prisma.auditIssue.findMany = originals.auditIssueFindMany;
    prisma.novelBible.findUnique = originals.novelBibleFindUnique;
    prisma.chapterSummary.findMany = originals.chapterSummaryFindMany;
    prisma.consistencyFact.findMany = originals.consistencyFactFindMany;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.creativeDecisionFindMany = originals.creativeDecisionFindMany;
    plannerService.ensureChapterPlan = originals.ensureChapterPlan;
    plannerService.buildPlanPromptBlock = originals.buildPlanPromptBlock;
    contextAssemblyService.build = originals.buildStateContext;
    novelReferenceService.buildReferenceForStage = originals.buildReferenceForStage;
    characterDynamicsQueryService.getOverview = originals.getCharacterDynamics;
    ragServices.hybridRetrievalService.buildContextBlock = originals.buildRagContext;
    payoffLedgerSyncService.getPayoffLedger = originals.getPayoffLedger;
    characterResourceLedgerService.buildContext = originals.buildCharacterResourceContext;
  }
});

