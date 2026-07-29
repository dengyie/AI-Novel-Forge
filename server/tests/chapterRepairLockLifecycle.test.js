const test = require("node:test");
const assert = require("node:assert/strict");

const promptRunner = require("../dist/prompting/core/promptRunner.js");
const { prisma } = require("../dist/db/prisma.js");
const { ChapterRuntimeCoordinator } = require("../dist/services/novel/runtime/ChapterRuntimeCoordinator.js");
const {
  getChapterRepairLockTableSizeForTests,
  resetChapterRepairLocksForTests,
} = require("../dist/services/novel/runtime/repair/ChapterRepairStreamRuntime.js");

function createRepairAssembledChapter() {
  const now = new Date().toISOString();
  return {
    novel: {
      id: "novel-1",
      title: "测试小说",
    },
    chapter: {
      id: "chapter-1",
      title: "第1章",
      order: 1,
      content: "旧正文里有一段需要修复的内容。",
      expectation: "推进第一次反压。",
    },
    contextPackage: {
      chapter: {
        id: "chapter-1",
        title: "第1章",
        order: 1,
        content: "旧正文里有一段需要修复的内容。",
        expectation: "推进第一次反压。",
        supportingContextText: "",
      },
      plan: {
        id: "plan-1",
        chapterId: "chapter-1",
        planRole: "pressure",
        phaseLabel: "起势",
        title: "第1章计划",
        objective: "推进第一次反压。",
        participants: ["主角"],
        reveals: [],
        riskNotes: [],
        mustAdvance: ["推进反压结果"],
        mustPreserve: ["压迫感"],
        sourceIssueIds: [],
        replannedFromPlanId: null,
        hookTarget: "留下下一轮追击",
        rawPlanJson: null,
        scenes: [],
        createdAt: now,
        updatedAt: now,
      },
      stateSnapshot: null,
      openConflicts: [],
      storyWorldSlice: null,
      characterRoster: [{
        id: "char-1",
        name: "主角",
        role: "主角",
      }],
      creativeDecisions: [],
      openAuditIssues: [],
      previousChaptersSummary: [],
      openingHint: "Recent openings: none.",
      continuation: {
        enabled: false,
        sourceType: null,
        sourceId: null,
        sourceTitle: "",
        systemRule: "",
        humanBlock: "",
        antiCopyCorpus: [],
      },
      styleContext: null,
      ledgerPendingItems: [],
      ledgerUrgentItems: [],
      ledgerOverdueItems: [],
      ledgerSummary: null,
      characterDynamics: {
        novelId: "novel-1",
        currentVolume: {
          id: "volume-1",
          title: "第一卷",
          sortOrder: 1,
          startChapterOrder: 1,
          endChapterOrder: 10,
          currentChapterOrder: 1,
        },
        summary: "第一卷需要建立反压结果。",
        pendingCandidateCount: 0,
        characters: [],
        relations: [],
        candidates: [],
        factionTracks: [],
        assignments: [],
      },
      bookContract: {
        title: "测试小说",
        genre: "都市",
        targetAudience: "新手向男频读者",
        sellingPoint: "高压开局",
        first30ChapterPromise: "尽快兑现压迫与反压",
        narrativePov: "limited-third-person",
        pacePreference: "fast",
        emotionIntensity: "high",
        toneGuardrails: [],
        hardConstraints: [],
      },
      macroConstraints: null,
      volumeWindow: {
        volumeId: "volume-1",
        sortOrder: 1,
        title: "第一卷",
        missionSummary: "完成第一次反压",
        adjacentSummary: "",
        pendingPayoffs: [],
        softFutureSummary: null,
      },
      nextAction: "write_chapter",
      pendingReviewProposalCount: 0,
      chapterWriteContext: {
        bookContract: {
          title: "测试小说",
          genre: "都市",
          targetAudience: "新手向男频读者",
          sellingPoint: "高压开局",
          first30ChapterPromise: "尽快兑现压迫与反压",
          narrativePov: "limited-third-person",
          pacePreference: "fast",
          emotionIntensity: "high",
          toneGuardrails: [],
          hardConstraints: [],
        },
        macroConstraints: null,
        volumeWindow: {
          volumeId: "volume-1",
          sortOrder: 1,
          title: "第一卷",
          missionSummary: "完成第一次反压",
          adjacentSummary: "无",
          pendingPayoffs: [],
          softFutureSummary: "无",
        },
        chapterMission: {
          chapterId: "chapter-1",
          chapterOrder: 1,
          title: "第1章",
          objective: "推进第一次反压。",
          expectation: "推进第一次反压。",
          planRole: "pressure",
          hookTarget: "留下下一轮追击",
          mustAdvance: ["推进第一次反压。"],
          mustPreserve: ["压迫感"],
          riskNotes: [],
          targetWordCount: 3000,
        },
        nextAction: "write_chapter",
        chapterStateGoal: null,
        protectedSecrets: [],
        payoffDirectives: [],
        chapterBoundary: null,
        lengthBudget: null,
        scenePlan: null,
        participants: [{
          id: "char-1",
          name: "主角",
          role: "主角",
        }],
        characterBehaviorGuides: [],
        activeRelationStages: [],
        pendingCandidateGuards: [],
        ledgerPendingItems: [],
        ledgerUrgentItems: [],
        ledgerOverdueItems: [],
        ledgerSummary: null,
        localStateSummary: "主角正在准备第一次反压。",
        openConflictSummaries: ["第一次反压尚未真正落地。"],
        recentChapterSummaries: [],
        openingAntiRepeatHint: "Recent openings: none.",
        styleConstraints: [],
        continuationConstraints: [],
        completedMilestones: [],
        recentScenePatterns: [],
        characterHardFacts: [],
      },
    },
  };
}

function makeCoordinator() {
  return new ChapterRuntimeCoordinator({
    assembler: {
      assemble: async () => createRepairAssembledChapter(),
    },
    artifactSyncService: {
      async syncChapterArtifacts() {
        return undefined;
      },
    },
    reviewChapterAfterRepair: async () => ({
      score: {
        coherence: 92,
        repetition: 93,
        pacing: 91,
        voice: 90,
        engagement: 94,
        overall: 92,
      },
      issues: [],
    }),
    resolveAuditIssues: async () => undefined,
    timelineFinalizer: {
      finalizeCurrentContent: async () => undefined,
      ensurePreviousChapterFinalized: async () => null,
    },
  });
}

function installPrismaHappyPath() {
  const originals = {
    novelFindUnique: prisma.novel.findUnique,
    chapterFindFirst: prisma.chapter.findFirst,
    bibleFindUnique: prisma.novelBible.findUnique,
    chapterUpdate: prisma.chapter.update,
    chapterUpdateMany: prisma.chapter.updateMany,
    transaction: prisma.$transaction,
    qualityReportFindFirst: prisma.qualityReport.findFirst,
    runStructured: promptRunner.runStructuredPrompt,
    streamText: promptRunner.streamTextPrompt,
  };
  prisma.novel.findUnique = async () => ({ id: "novel-1", title: "测试小说" });
  let chapterContent = "旧正文里有一段需要修复的内容。";
  let contentRevision = 7;
  prisma.chapter.findFirst = async () => ({
    id: "chapter-1",
    novelId: "novel-1",
    title: "第1章",
    order: 1,
    content: chapterContent,
    contentRevision,
    repairHistory: null,
    qualityScore: 70,
    continuityScore: 70,
    characterScore: 70,
    pacingScore: 70,
    riskFlags: null,
  });
  prisma.novelBible.findUnique = async () => ({ rawContent: "作品圣经" });
  prisma.qualityReport.findFirst = async () => ({
    coherence: 70,
    repetition: 70,
    pacing: 70,
    voice: 70,
    engagement: 70,
    overall: 70,
  });
  prisma.chapter.update = async ({ data }) => ({ id: "chapter-1", ...data });
  prisma.chapter.updateMany = async ({ where, data }) => {
    if (where.contentRevision !== contentRevision) {
      return { count: 0 };
    }
    chapterContent = data.content;
    contentRevision += 1;
    return { count: 1 };
  };
  prisma.$transaction = async (callback) => callback({
    chapter: {
      update: prisma.chapter.update,
      updateMany: async ({ where }) => ({
        count: where.contentRevision === contentRevision ? 1 : 0,
      }),
      findFirst: async () => ({ contentRevision }),
    },
    qualityReport: {
      create: async () => ({ id: "quality-report-1" }),
    },
  });
  // force heavy path so streamTextPrompt is used
  promptRunner.runStructuredPrompt = async () => {
    throw new Error("[{\"origin\":\"string\",\"code\":\"too_small\",\"minimum\":6,\"inclusive\":true,\"path\":[\"patches\",0,\"targetExcerpt\"],\"message\":\"Too small\"}]");
  };
  promptRunner.streamTextPrompt = async () => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield { content: "全文修复片段" };
      },
    },
    complete: Promise.resolve({ output: "全文修复后的正文" }),
  });
  return () => {
    prisma.novel.findUnique = originals.novelFindUnique;
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.novelBible.findUnique = originals.bibleFindUnique;
    prisma.chapter.update = originals.chapterUpdate;
    prisma.chapter.updateMany = originals.chapterUpdateMany;
    prisma.$transaction = originals.transaction;
    prisma.qualityReport.findFirst = originals.qualityReportFindFirst;
    promptRunner.runStructuredPrompt = originals.runStructured;
    promptRunner.streamTextPrompt = originals.streamText;
  };
}

test("createRepairStream releases lock after normal stream + onDone", async () => {
  resetChapterRepairLocksForTests();
  const restore = installPrismaHappyPath();
  try {
    const coordinator = makeCoordinator();
    const result = await coordinator.createRepairStream("novel-1", "chapter-1", {
      repairMode: "heavy_repair",
      reviewIssues: [{
        severity: "high",
        category: "pacing",
        evidence: "第一次反压没有真正落地。",
        fixSuggestion: "让主角在本章拿到明确反压结果。",
      }],
    });
    assert.equal(getChapterRepairLockTableSizeForTests() >= 1, true, "lock held while stream open");
    for await (const _chunk of result.stream) {
      // drain
    }
    await result.onDone("全文修复后的正文", { writeFrame() {} });
    assert.equal(getChapterRepairLockTableSizeForTests(), 0, "lock released after onDone");
  } finally {
    restore();
    resetChapterRepairLocksForTests();
  }
});

test("createRepairStream releases lock when consumer aborts mid-stream (C1/F10)", async () => {
  resetChapterRepairLocksForTests();
  const restore = installPrismaHappyPath();
  // infinite-ish stream so break mid-iteration is meaningful
  promptRunner.streamTextPrompt = async () => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield { content: "chunk-a" };
        yield { content: "chunk-b" };
        yield { content: "chunk-c" };
      },
    },
    complete: Promise.resolve({ output: "never used" }),
  });
  try {
    const coordinator = makeCoordinator();
    const result = await coordinator.createRepairStream("novel-1", "chapter-1", {
      repairMode: "heavy_repair",
      reviewIssues: [{
        severity: "high",
        category: "pacing",
        evidence: "第一次反压没有真正落地。",
        fixSuggestion: "让主角在本章拿到明确反压结果。",
      }],
    });
    let n = 0;
    try {
      for await (const _chunk of result.stream) {
        n += 1;
        if (n >= 1) {
          break; // consumer break → guardStream naturalEnd=false → releaseOnce
        }
      }
    } catch {
      // ignore
    }
    // give microtasks a tick
    await Promise.resolve();
    assert.equal(getChapterRepairLockTableSizeForTests(), 0, "lock released after mid-stream break");
  } finally {
    restore();
    resetChapterRepairLocksForTests();
  }
});

test("createRepairStream aborts before handoff when signal already aborted (C1)", async () => {
  resetChapterRepairLocksForTests();
  const restore = installPrismaHappyPath();
  const controller = new AbortController();
  // abort during assemble (after entities load): make findUnique slow-ish then abort
  const originalFind = prisma.novel.findUnique;
  prisma.novel.findUnique = async (...args) => {
    controller.abort();
    return originalFind(...args);
  };
  try {
    const coordinator = makeCoordinator();
    await assert.rejects(
      () => coordinator.createRepairStream("novel-1", "chapter-1", {
        repairMode: "heavy_repair",
        signal: controller.signal,
        reviewIssues: [{
          severity: "high",
          category: "pacing",
          evidence: "第一次反压没有真正落地。",
          fixSuggestion: "让主角在本章拿到明确反压结果。",
        }],
      }),
      /repair aborted \(signal\)/,
    );
    assert.equal(getChapterRepairLockTableSizeForTests(), 0, "lock released when abort before handoff");
  } finally {
    restore();
    resetChapterRepairLocksForTests();
  }
});

test("createRepairStream releases lock when entity missing (throw before handoff)", async () => {
  resetChapterRepairLocksForTests();
  const restore = installPrismaHappyPath();
  prisma.novel.findUnique = async () => null;
  prisma.chapter.findFirst = async () => null;
  try {
    const coordinator = makeCoordinator();
    await assert.rejects(
      () => coordinator.createRepairStream("novel-missing", "chapter-missing", {
        repairMode: "heavy_repair",
        reviewIssues: [],
      }),
      /不存在/,
    );
    assert.equal(getChapterRepairLockTableSizeForTests(), 0, "lock released on create failure");
  } finally {
    restore();
    resetChapterRepairLocksForTests();
  }
});
