const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  CHAPTER_CONTENT_CONFLICT_CODE,
} = require("../dist/services/novel/chapterContentCas.js");
const {
  ChapterArtifactSyncService,
} = require("../dist/services/novel/runtime/ChapterArtifactSyncService.js");
const {
  ChapterContentCommitService,
} = require("../dist/services/novel/runtime/content/ChapterContentCommitService.js");
const { ChapterWritingGraph } = require("../dist/services/novel/chapterWritingGraph.js");
const promptRunner = require("../dist/prompting/core/promptRunner.js");

test("initial writer draft cannot overwrite a manual edit saved after generation started", async () => {
  const originalUpdate = prisma.chapter.update;
  const row = {
    novelId: "novel-1",
    id: "chapter-1",
    content: "生成开始时的旧正文",
    contentRevision: 7,
    generationState: "pending",
    chapterStatus: "pending_generation",
  };

  const db = {
    chapter: {
      async updateMany(input) {
        const matches = input.where.id === row.id
          && input.where.novelId === row.novelId
          && input.where.contentRevision === row.contentRevision;
        if (!matches) {
          return { count: 0 };
        }
        row.content = input.data.content;
        row.contentRevision += input.data.contentRevision.increment;
        row.generationState = input.data.generationState;
        row.chapterStatus = input.data.chapterStatus;
        return { count: 1 };
      },
      async findFirst(input) {
        if (input.where.id !== row.id || input.where.novelId !== row.novelId) {
          return null;
        }
        return { contentRevision: row.contentRevision };
      },
    },
  };

  try {
    // 模拟 writer 以 revision 7 开始生成后，用户先保存了 revision 8。
    row.content = "人工保存的新正文";
    row.contentRevision = 8;

    // RED 兼容：旧实现仍走无条件 update，会真实覆盖内存行；修复后必须只走上述 CAS updateMany。
    prisma.chapter.update = async (input) => {
      row.content = input.data.content;
      row.contentRevision += input.data.contentRevision.increment;
      row.generationState = input.data.generationState;
      row.chapterStatus = input.data.chapterStatus;
      return { ...row };
    };

    const contentCommitService = new ChapterContentCommitService(db);
    const service = new ChapterArtifactSyncService(contentCommitService);

    await assert.rejects(
      () => service.saveDraftAndArtifacts(
        "novel-1",
        "chapter-1",
        "后台生成的草稿",
        "drafted",
        {
          expectedContentRevision: 7,
          syncArtifacts: false,
        },
      ),
      (error) => {
        assert.equal(error.details.code, CHAPTER_CONTENT_CONFLICT_CODE);
        return true;
      },
    );

    assert.equal(row.content, "人工保存的新正文");
    assert.equal(row.contentRevision, 8);
  } finally {
    prisma.chapter.update = originalUpdate;
  }
});

function buildLengthDebtContextPackage() {
  return {
    chapter: {
      title: "第1章",
      targetWordCount: 1000,
      sceneCards: null,
      expectation: "推进。",
    },
    chapterWriteContext: {
      bookContract: {
        title: "测试",
        genre: "测试",
        targetAudience: "读者",
        sellingPoint: "卖点",
        first30ChapterPromise: "前三十章承诺",
        narrativePov: "第三人称",
        pacePreference: "中",
        emotionIntensity: "中",
        toneGuardrails: [],
        hardConstraints: [],
      },
      macroConstraints: null,
      volumeWindow: null,
      chapterMission: {
        chapterId: "chapter-1",
        chapterOrder: 1,
        title: "第1章",
        objective: "推进。",
        expectation: "推进。",
        targetWordCount: 1000,
        mustAdvance: [],
        mustPreserve: [],
        hookTarget: "",
        taskSheet: "",
        riskNotes: [],
      },
      nextAction: "write_chapter",
      chapterStateGoal: null,
      protectedSecrets: [],
      payoffDirectives: [],
      obligationContract: {
        mustHitNow: [],
        mustPreserve: [],
        requiredPayoffTouches: [],
        requiredCharacterAppearances: [],
        requiredGoalChanges: [],
        canDefer: [],
        forbiddenCrossings: [],
      },
      chapterBoundary: null,
      lengthBudget: null,
      scenePlan: null,
      participants: [],
      characterHardFacts: [],
      characterBehaviorGuides: [],
      activeRelationStages: [],
      pendingCandidateGuards: [],
      localStateSummary: "无",
      openConflictSummaries: [],
      ledgerPendingItems: [],
      ledgerUrgentItems: [],
      ledgerOverdueItems: [],
      ledgerSummary: null,
      timelineContext: null,
      characterResourceContext: null,
      recentChapterSummaries: [],
      previousChapterTail: null,
      openingAntiRepeatHint: "none",
      styleContract: null,
      styleConstraints: [],
      continuationConstraints: [],
      ragFacts: [],
      completedMilestones: [],
      recentScenePatterns: [],
    },
    ragContext: "",
    continuation: {
      enabled: false,
      sourceType: null,
      sourceId: null,
      sourceTitle: "",
      systemRule: "",
      humanBlock: "",
      antiCopyCorpus: [],
    },
  };
}

test("writer CAS miss leaves manual body, revision, and risk flags unchanged after length debt", async () => {
  const originalStreamTextPrompt = promptRunner.streamTextPrompt;
  const originalRunTextPrompt = promptRunner.runTextPrompt;
  const originalFindFirst = prisma.chapter.findFirst;
  const originalUpdate = prisma.chapter.update;
  const manualRiskFlags = JSON.stringify({ manualReview: { note: "保留人工判断" } });
  const row = {
    novelId: "novel-1",
    id: "chapter-1",
    content: "生成开始时的旧正文",
    contentRevision: 7,
    generationState: "pending",
    chapterStatus: "pending_generation",
    riskFlags: JSON.stringify({ beforeGeneration: true }),
  };

  const db = {
    chapter: {
      async updateMany(input) {
        const matches = input.where.id === row.id
          && input.where.novelId === row.novelId
          && input.where.contentRevision === row.contentRevision;
        if (!matches) {
          return { count: 0 };
        }
        row.content = input.data.content;
        row.contentRevision += input.data.contentRevision.increment;
        row.generationState = input.data.generationState;
        row.chapterStatus = input.data.chapterStatus;
        return { count: 1 };
      },
      async findFirst(input) {
        if (input.where.id !== row.id || input.where.novelId !== row.novelId) {
          return null;
        }
        return { contentRevision: row.contentRevision };
      },
    },
  };

  promptRunner.streamTextPrompt = async () => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield { content: "风掠过长街，门后传来急促脚步声。" };
      },
    },
    complete: Promise.resolve({ output: "风掠过长街，门后传来急促脚步声。" }),
  });
  promptRunner.runTextPrompt = async () => ({ output: "" });
  prisma.chapter.findFirst = async (input) => {
    const matches = input.where.id === row.id
      && input.where.novelId === row.novelId;
    return matches ? { riskFlags: row.riskFlags } : null;
  };
  prisma.chapter.update = async (input) => {
    row.riskFlags = input.data.riskFlags;
    return { ...row };
  };

  try {
    const artifactService = new ChapterArtifactSyncService(new ChapterContentCommitService(db));
    const graph = new ChapterWritingGraph({
      enforceOpeningDiversity: async (_novelId, _order, _title, content) => ({
        content,
        rewritten: false,
        maxSimilarity: 0,
      }),
      saveDraftAndArtifacts: (...args) => artifactService.saveDraftAndArtifacts(...args),
      logInfo: () => {},
      logWarn: () => {},
    });
    const streamResult = await graph.createChapterStream({
      novelId: row.novelId,
      novelTitle: "测试",
      chapter: {
        id: row.id,
        title: "第1章",
        order: 1,
        contentRevision: 7,
        targetWordCount: 1000,
      },
      contextPackage: buildLengthDebtContextPackage(),
      options: {},
    });

    // writer 持有 revision 7 时，人工保存正文和风险标记并推进到 revision 8。
    row.content = "人工保存的新正文";
    row.contentRevision = 8;
    row.riskFlags = manualRiskFlags;

    await assert.rejects(
      () => streamResult.onDone("风掠过长街，门后传来急促脚步声。"),
      (error) => {
        assert.equal(error.details.code, CHAPTER_CONTENT_CONFLICT_CODE);
        return true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(row.content, "人工保存的新正文");
    assert.equal(row.contentRevision, 8);
    assert.equal(row.riskFlags, manualRiskFlags);
  } finally {
    promptRunner.streamTextPrompt = originalStreamTextPrompt;
    promptRunner.runTextPrompt = originalRunTextPrompt;
    prisma.chapter.findFirst = originalFindFirst;
    prisma.chapter.update = originalUpdate;
  }
});
