const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadDirectorTakeoverState,
  stateRangeHasPendingWork,
  isExplicitAutoExecutionRescopeRequest,
  resolveNextPreparedExecutableRangeFromChapters,
} = require("../dist/services/novel/director/runtime/novelDirectorTakeoverRuntime.js");
const { prisma } = require("../dist/db/prisma.js");

function buildSceneCards(chapterId, targetWordCount = 2800) {
  return JSON.stringify({
    targetWordCount,
    lengthBudget: {
      targetWordCount,
      softMinWordCount: Math.round(targetWordCount * 0.85),
      softMaxWordCount: Math.round(targetWordCount * 1.15),
      hardMaxWordCount: Math.round(targetWordCount * 1.25),
    },
    scenes: [1, 2, 3].map((index) => ({
      key: `${chapterId}-scene-${index}`,
      title: `场景${index}`,
      purpose: `推进${index}`,
      mustAdvance: [`推进点${index}`],
      mustPreserve: ["不提前揭晓终局"],
      entryState: `入场${index}`,
      exitState: `离场${index}`,
      forbiddenExpansion: ["不跨章"],
      targetWordCount: Math.round(targetWordCount / 3),
    })),
  });
}

function buildContractChapter(order, overrides = {}) {
  const id = overrides.id ?? `chapter_${order}`;
  return {
    id,
    order,
    expectation: overrides.expectation ?? `第${order}章目标`,
    generationState: overrides.generationState ?? "planned",
    chapterStatus: overrides.chapterStatus ?? "pending_generation",
    content: overrides.content ?? "",
    conflictLevel: overrides.conflictLevel ?? 50,
    revealLevel: overrides.revealLevel ?? 40,
    targetWordCount: overrides.targetWordCount ?? 2800,
    mustAvoid: overrides.mustAvoid ?? "不要越界",
    taskSheet: overrides.taskSheet ?? `第${order}章任务单：推进主线冲突。`,
    sceneCards: overrides.sceneCards ?? buildSceneCards(id),
  };
}

function buildNovelRow(novelId) {
  return {
    id: novelId,
    title: "Range Precedence",
    description: "test",
    targetAudience: null,
    bookSellingPoint: null,
    competingFeel: null,
    first30ChapterPromise: null,
    commercialTagsJson: "[]",
    genreId: null,
    primaryStoryModeId: null,
    secondaryStoryModeId: null,
    worldId: null,
    writingMode: "original",
    projectMode: "ai_led",
    narrativePov: "third_person",
    pacePreference: "balanced",
    styleTone: null,
    emotionIntensity: "medium",
    aiFreedom: "medium",
    defaultChapterLength: 3000,
    estimatedChapterCount: 40,
    projectStatus: "in_progress",
    storylineStatus: "in_progress",
    outlineStatus: "in_progress",
    resourceReadyScore: null,
    sourceNovelId: null,
    sourceKnowledgeDocumentId: null,
    continuationBookAnalysisId: null,
    continuationBookAnalysisSections: null,
    bookContract: {
      id: "contract_1",
      novelId,
      readingPromise: "promise",
      protagonistFantasy: "fantasy",
      coreSellingPoint: "selling",
      chapter3Payoff: "c3",
      chapter10Payoff: "c10",
      chapter30Payoff: "c30",
      escalationLadder: "ladder",
      relationshipMainline: "relation",
      absoluteRedLinesJson: "[]",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
}

function buildWorkspace(orders) {
  return {
    volumes: [
      {
        id: "volume_1",
        sortOrder: 1,
        title: "第一卷",
        chapters: orders.map((order) => ({
          id: `chapter_${order}`,
          volumeId: "volume_1",
          chapterOrder: order,
          title: `第${order}章`,
          summary: `摘要${order}`,
          purpose: `目标${order}`,
          exclusiveEvent: `事件${order}`,
          endingState: `结束态${order}`,
          nextChapterEntryState: `下章入口${order}`,
          conflictLevel: 50,
          revealLevel: 40,
          targetWordCount: 2800,
          mustAvoid: "不要越界",
          taskSheet: `第${order}章任务单`,
          sceneCards: buildSceneCards(`chapter_${order}`),
          payoffRefs: [],
        })),
      },
    ],
    beatSheets: [
      {
        volumeId: "volume_1",
        beats: [
          {
            key: "beat_1",
            label: "起势",
            summary: "覆盖窗",
            chapterSpanHint: `${orders[0]}-${orders[orders.length - 1]}章`,
            expectedChapterCount: orders.length,
          },
        ],
      },
    ],
  };
}

test("stateRangeHasPendingWork is false when all chapters in state window are approved", () => {
  const chapters = [11, 12, 13].map((order) => buildContractChapter(order, {
    generationState: "approved",
    chapterStatus: "completed",
    content: `正文${order}`,
  }));
  assert.equal(stateRangeHasPendingWork(chapters, {
    enabled: true,
    mode: "chapter_range",
    startOrder: 11,
    endOrder: 13,
  }), false);
  assert.equal(stateRangeHasPendingWork(chapters, {
    enabled: true,
    mode: "chapter_range",
    startOrder: 11,
    endOrder: 13,
  }), false);
  chapters[1].generationState = "planned";
  chapters[1].content = "";
  assert.equal(stateRangeHasPendingWork(chapters, {
    enabled: true,
    mode: "chapter_range",
    startOrder: 11,
    endOrder: 13,
  }), true);
});

// P2-1 fix regression: a chapter carrying blocking replan/manual_gate qualityLoop
// in riskFlags must be treated as pending (not processed), so the takeover loader
// (which now selects riskFlags) detects the blocking debt and does not roll past it.
// Before the fix, the takeover findMany select omitted riskFlags → the chapter was
// misclassified as processed → stateRangeHasPendingWork=false → wrong roll skipped repair.
test("stateRangeHasPendingWork treats blocking-riskFlags chapter as pending (riskFlags loaded)", () => {
  const blockingRiskFlags = JSON.stringify({
    qualityLoop: {
      chapterOrder: 12,
      overallStatus: "invalid",
      recommendedAction: "replan",
      rootCauseCode: "replan_required",
      budget: { attempt: 1, maxAttempts: 3, nextAction: "patch_repair", exhausted: false },
    },
  });
  // Chapter 12 is "reviewed" + "pending_review" (would normally look processed),
  // but its riskFlags mark blocking replan debt → must be pending (not processed).
  const chapters = [11, 12, 13].map((order) => buildContractChapter(order, {
    generationState: "approved",
    chapterStatus: "completed",
    content: `正文${order}`,
  }));
  chapters[1].generationState = "reviewed";
  chapters[1].chapterStatus = "pending_review";
  chapters[1].content = "正文12";
  chapters[1].riskFlags = blockingRiskFlags;
  const state = { enabled: true, mode: "chapter_range", startOrder: 11, endOrder: 13 };
  assert.equal(stateRangeHasPendingWork(chapters, state), true,
    "chapter 12 has blocking replan debt → must be pending → window has work");
  // Sanity: without riskFlags the same chapter is still processed (reviewed+pending_review).
  chapters[1].riskFlags = null;
  assert.equal(stateRangeHasPendingWork(chapters, state), false,
    "without blocking riskFlags, reviewed+pending_review chapter is processed");
});

test("isExplicitAutoExecutionRescopeRequest detects chapter_range override", () => {
  assert.equal(isExplicitAutoExecutionRescopeRequest({
    requestedPlan: { mode: "chapter_range", startOrder: 21, endOrder: 30 },
    state: { enabled: true, mode: "chapter_range", startOrder: 11, endOrder: 20 },
  }), true);
  assert.equal(isExplicitAutoExecutionRescopeRequest({
    requestedPlan: { mode: "chapter_range", startOrder: 11, endOrder: 20 },
    state: { enabled: true, mode: "chapter_range", startOrder: 11, endOrder: 20 },
  }), false);
  // book/volume are intentional re-scopes relative to a chapter_range state window
  assert.equal(isExplicitAutoExecutionRescopeRequest({
    requestedPlan: { mode: "book" },
    state: { enabled: true, mode: "chapter_range", startOrder: 11, endOrder: 20 },
  }), true);
  assert.equal(isExplicitAutoExecutionRescopeRequest({
    requestedPlan: null,
    state: { enabled: true, mode: "chapter_range", startOrder: 11, endOrder: 20 },
  }), false);
});

test("resolveNextPreparedExecutableRangeFromChapters skips completed batch", () => {
  const chapters = [
    ...[11, 12].map((order) => buildContractChapter(order, {
      generationState: "approved",
      chapterStatus: "completed",
      content: `done ${order}`,
    })),
    ...[21, 22, 23].map((order) => buildContractChapter(order, {
      generationState: "planned",
      chapterStatus: "pending_generation",
      content: "",
    })),
  ];
  const next = resolveNextPreparedExecutableRangeFromChapters(chapters, 20);
  assert.equal(next?.startOrder, 21);
  assert.equal(next?.endOrder, 23);
  assert.equal(next?.nextChapterOrder, 21);
});

test("loadDirectorTakeoverState does not rebind completed 11-20 when 21-30 prepared pending", async () => {
  const originals = {
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    generationJobFindFirst: prisma.generationJob.findFirst,
  };
  const orders = [...Array.from({ length: 10 }, (_v, i) => 11 + i), ...Array.from({ length: 10 }, (_v, i) => 21 + i)];
  const workspace = buildWorkspace(orders);
  const chapterRows = [
    ...Array.from({ length: 10 }, (_v, i) => buildContractChapter(11 + i, {
      generationState: "approved",
      chapterStatus: "completed",
      content: `正文${11 + i}`,
    })),
    ...Array.from({ length: 10 }, (_v, i) => buildContractChapter(21 + i, {
      generationState: "planned",
      chapterStatus: "pending_generation",
      content: "",
    })),
  ];

  prisma.novel.findUnique = async () => buildNovelRow("novel_no_rewind");
  prisma.chapter.findMany = async () => chapterRows;
  prisma.generationJob.findFirst = async () => null;

  try {
    const state = await loadDirectorTakeoverState({
      novelId: "novel_no_rewind",
      getStoryMacroPlan: async () => ({
        storyInput: "story",
        decomposition: { premise: "premise" },
      }),
      getDirectorAssetSnapshot: async () => ({
        characterCount: 4,
        chapterCount: 20,
        volumeCount: 1,
        hasVolumeStrategyPlan: true,
        firstVolumeId: "volume_1",
        firstVolumeChapterCount: 20,
        volumeChapterRanges: [{ volumeOrder: 1, startOrder: 1, endOrder: 40 }],
        structuredOutlineChapterOrders: orders,
      }),
      getVolumeWorkspace: async () => workspace,
      findActiveAutoDirectorTask: async () => null,
      findLatestAutoDirectorTask: async () => ({
        id: "task_completed_batch",
        checkpointType: null,
        checkpointSummary: "batch done",
        resumeTargetJson: null,
        lastError: null,
        seedPayloadJson: JSON.stringify({
          runMode: "full_book_autopilot",
          autoExecutionPlan: { mode: "chapter_range", startOrder: 11, endOrder: 20 },
          autoExecution: {
            enabled: true,
            mode: "chapter_range",
            startOrder: 11,
            endOrder: 20,
            totalChapterCount: 10,
            firstChapterId: "chapter_11",
            nextChapterId: null,
            nextChapterOrder: null,
            skippedChapterIds: [],
            skippedChapterOrders: [],
            qualityDebtChapterIds: [],
            qualityDebtChapterOrders: [],
            qualityDebtSummaries: [],
          },
        }),
      }),
    });

    // Must roll to 21–30, never stay on completed 11–20.
    assert.notEqual(state.executableRange?.startOrder, 11);
    assert.equal(state.executableRange?.startOrder, 21);
    assert.equal(state.executableRange?.endOrder, 30);
    assert.equal(state.executableRange?.nextChapterOrder, 21);
  } finally {
    prisma.novel.findUnique = originals.novelFindUnique;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.generationJob.findFirst = originals.generationJobFindFirst;
  }
});

test("loadDirectorTakeoverState leaves executableRange null when next window unprepared", async () => {
  const originals = {
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    generationJobFindFirst: prisma.generationJob.findFirst,
  };
  // 11–20 done; 21–30 exist as shells without contracts
  const orders = [...Array.from({ length: 10 }, (_v, i) => 11 + i), ...Array.from({ length: 10 }, (_v, i) => 21 + i)];
  const workspace = {
    volumes: [
      {
        id: "volume_1",
        sortOrder: 1,
        title: "第一卷",
        chapters: orders.map((order) => (
          order <= 20
            ? {
                id: `chapter_${order}`,
                volumeId: "volume_1",
                chapterOrder: order,
                title: `第${order}章`,
                summary: `摘要${order}`,
                purpose: `目标${order}`,
                exclusiveEvent: `事件${order}`,
                endingState: `结束态${order}`,
                nextChapterEntryState: `下章入口${order}`,
                conflictLevel: 50,
                revealLevel: 40,
                targetWordCount: 2800,
                mustAvoid: "不要越界",
                taskSheet: `第${order}章任务单`,
                sceneCards: buildSceneCards(`chapter_${order}`),
                payoffRefs: [],
              }
            : {
                id: `chapter_${order}`,
                volumeId: "volume_1",
                chapterOrder: order,
                title: `第${order}章`,
                summary: `摘要${order}`,
                purpose: null,
                conflictLevel: null,
                revealLevel: null,
                targetWordCount: null,
                mustAvoid: null,
                taskSheet: null,
                sceneCards: null,
                payoffRefs: [],
              }
        )),
      },
    ],
    beatSheets: [
      {
        volumeId: "volume_1",
        beats: [{
          key: "beat_1",
          label: "起势",
          summary: "覆盖",
          chapterSpanHint: "11-30章",
          expectedChapterCount: 20,
        }],
      },
    ],
  };
  const chapterRows = [
    ...Array.from({ length: 10 }, (_v, i) => buildContractChapter(11 + i, {
      generationState: "approved",
      chapterStatus: "completed",
      content: `正文${11 + i}`,
    })),
    ...Array.from({ length: 10 }, (_v, i) => ({
      id: `chapter_${21 + i}`,
      order: 21 + i,
      expectation: null,
      generationState: "planned",
      chapterStatus: "unplanned",
      content: "",
      conflictLevel: null,
      revealLevel: null,
      targetWordCount: null,
      mustAvoid: null,
      taskSheet: null,
      sceneCards: null,
    })),
  ];

  prisma.novel.findUnique = async () => buildNovelRow("novel_roll_unprepared");
  prisma.chapter.findMany = async () => chapterRows;
  prisma.generationJob.findFirst = async () => null;

  try {
    const state = await loadDirectorTakeoverState({
      novelId: "novel_roll_unprepared",
      getStoryMacroPlan: async () => ({
        storyInput: "story",
        decomposition: { premise: "premise" },
      }),
      getDirectorAssetSnapshot: async () => ({
        characterCount: 4,
        chapterCount: 20,
        volumeCount: 1,
        hasVolumeStrategyPlan: true,
        firstVolumeId: "volume_1",
        firstVolumeChapterCount: 20,
        volumeChapterRanges: [{ volumeOrder: 1, startOrder: 1, endOrder: 40 }],
        structuredOutlineChapterOrders: orders,
      }),
      getVolumeWorkspace: async () => workspace,
      findActiveAutoDirectorTask: async () => null,
      findLatestAutoDirectorTask: async () => ({
        id: "task_need_outline",
        checkpointType: null,
        checkpointSummary: null,
        resumeTargetJson: null,
        lastError: null,
        seedPayloadJson: JSON.stringify({
          runMode: "full_book_autopilot",
          autoExecutionPlan: { mode: "chapter_range", startOrder: 11, endOrder: 20 },
          autoExecution: {
            enabled: true,
            mode: "chapter_range",
            startOrder: 11,
            endOrder: 20,
            totalChapterCount: 10,
            firstChapterId: "chapter_11",
            nextChapterId: null,
            nextChapterOrder: null,
            skippedChapterIds: [],
            skippedChapterOrders: [],
          },
        }),
      }),
    });

    assert.equal(state.executableRange, null);
    assert.equal(state.snapshot.hasUnpreparedChaptersInRange, true);
    assert.ok(state.snapshot.missingExecutionContractOrders.some((order) => order >= 21));
  } finally {
    prisma.novel.findUnique = originals.novelFindUnique;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.generationJob.findFirst = originals.generationJobFindFirst;
  }
});

test("loadDirectorTakeoverState keeps resume range when state window still has pending", async () => {
  const originals = {
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    generationJobFindFirst: prisma.generationJob.findFirst,
  };
  const orders = [11, 12, 13];
  const workspace = buildWorkspace(orders);
  const chapterRows = [
    buildContractChapter(11, {
      generationState: "approved",
      chapterStatus: "completed",
      content: "done 11",
    }),
    buildContractChapter(12, {
      generationState: "planned",
      chapterStatus: "pending_generation",
      content: "",
    }),
    buildContractChapter(13, {
      generationState: "planned",
      chapterStatus: "pending_generation",
      content: "",
    }),
  ];

  prisma.novel.findUnique = async () => buildNovelRow("novel_resume_pending");
  prisma.chapter.findMany = async () => chapterRows;
  prisma.generationJob.findFirst = async () => null;

  try {
    const state = await loadDirectorTakeoverState({
      novelId: "novel_resume_pending",
      getStoryMacroPlan: async () => ({
        storyInput: "story",
        decomposition: { premise: "premise" },
      }),
      getDirectorAssetSnapshot: async () => ({
        characterCount: 4,
        chapterCount: 3,
        volumeCount: 1,
        hasVolumeStrategyPlan: true,
        firstVolumeId: "volume_1",
        firstVolumeChapterCount: 3,
        volumeChapterRanges: [{ volumeOrder: 1, startOrder: 11, endOrder: 13 }],
        structuredOutlineChapterOrders: orders,
      }),
      getVolumeWorkspace: async () => workspace,
      findActiveAutoDirectorTask: async () => null,
      findLatestAutoDirectorTask: async () => ({
        id: "task_resume",
        checkpointType: "chapter_batch_ready",
        checkpointSummary: "mid batch",
        resumeTargetJson: JSON.stringify({ chapterId: "chapter_12", volumeId: "volume_1" }),
        lastError: null,
        seedPayloadJson: JSON.stringify({
          autoExecutionPlan: { mode: "chapter_range", startOrder: 11, endOrder: 13 },
          autoExecution: {
            enabled: true,
            mode: "chapter_range",
            startOrder: 11,
            endOrder: 13,
            totalChapterCount: 3,
            firstChapterId: "chapter_11",
            nextChapterId: "chapter_12",
            nextChapterOrder: 12,
            skippedChapterIds: [],
            skippedChapterOrders: [],
          },
        }),
      }),
    });

    assert.equal(state.executableRange?.startOrder, 11);
    assert.equal(state.executableRange?.endOrder, 13);
    assert.equal(state.executableRange?.nextChapterOrder, 12);
  } finally {
    prisma.novel.findUnique = originals.novelFindUnique;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.generationJobFindFirst = originals.generationJobFindFirst;
  }
});
