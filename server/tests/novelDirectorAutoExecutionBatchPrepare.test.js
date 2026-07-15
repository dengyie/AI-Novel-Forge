const test = require("node:test");
const assert = require("node:assert/strict");

const {
  prepareNextAutoExecutionBatch,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionBatchPrepare.js");
const {
  buildVolumeWorkspaceDocument,
} = require("../dist/services/novel/volume/volumeWorkspaceDocument.js");
const { prisma } = require("../dist/db/prisma.js");

function createSceneCards(chapterOrder) {
  return JSON.stringify({
    targetWordCount: 2500,
    lengthBudget: {
      targetWordCount: 2500,
      softMinWordCount: 2200,
      softMaxWordCount: 2800,
      hardMaxWordCount: 3200,
    },
    scenes: [
      {
        key: `chapter-${chapterOrder}-scene-1`,
        title: `第${chapterOrder}章场景1`,
        purpose: "推进章节目标",
        mustAdvance: ["主线"],
        mustPreserve: ["人物动机"],
        entryState: "进入冲突",
        exitState: "压力升级",
        forbiddenExpansion: [],
        targetWordCount: 900,
      },
      {
        key: `chapter-${chapterOrder}-scene-2`,
        title: `第${chapterOrder}章场景2`,
        purpose: "升级选择压力",
        mustAdvance: ["冲突"],
        mustPreserve: ["设定边界"],
        entryState: "压力升级",
        exitState: "代价显形",
        forbiddenExpansion: [],
        targetWordCount: 800,
      },
      {
        key: `chapter-${chapterOrder}-scene-3`,
        title: `第${chapterOrder}章场景3`,
        purpose: "完成章末转折",
        mustAdvance: ["章末钩子"],
        mustPreserve: ["后续入口"],
        entryState: "代价显形",
        exitState: "进入下一章",
        forbiddenExpansion: [],
        targetWordCount: 800,
      },
    ],
  });
}

function createTitleOnlyChapter(id, chapterOrder, volumeId = "volume-1") {
  return {
    id,
    volumeId,
    chapterOrder,
    purpose: null,
    exclusiveEvent: null,
    endingState: null,
    nextChapterEntryState: null,
    conflictLevel: null,
    revealLevel: null,
    targetWordCount: null,
    mustAvoid: null,
    taskSheet: null,
    payoffRefs: [],
    sceneCards: null,
    beatKey: "volume-1-beat",
    title: `第${chapterOrder}章`,
    summary: `第${chapterOrder}章摘要`,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function createDetailedChapter(id, chapterOrder, volumeId = "volume-1") {
  return {
    id,
    volumeId,
    chapterOrder,
    purpose: `chapter ${chapterOrder} purpose`,
    exclusiveEvent: `chapter ${chapterOrder} exclusive event`,
    endingState: `chapter ${chapterOrder} ending state`,
    nextChapterEntryState: `chapter ${chapterOrder} next entry state`,
    conflictLevel: 3,
    revealLevel: 2,
    targetWordCount: 2500,
    mustAvoid: `chapter ${chapterOrder} avoid`,
    taskSheet: `chapter ${chapterOrder} task sheet 独占事件 在场人物 人物选择 现场压力 功能兑付 禁止事项`,
    payoffRefs: [],
    sceneCards: createSceneCards(chapterOrder),
    beatKey: "volume-1-beat",
    title: `第${chapterOrder}章`,
    summary: `第${chapterOrder}章摘要`,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function createVolume(id, sortOrder, title, chapters) {
  return {
    id,
    novelId: "novel-demo",
    sortOrder,
    title,
    summary: `${title}摘要`,
    openingHook: `${title}开卷抓手`,
    mainPromise: `${title}主承诺`,
    primaryPressureSource: `${title}压力源`,
    coreSellingPoint: `${title}核心卖点`,
    escalationMode: `${title}升级方式`,
    protagonistChange: `${title}主角变化`,
    midVolumeRisk: `${title}中段风险`,
    climax: `${title}高潮`,
    payoffType: `${title}兑现类型`,
    nextVolumeHook: `${title}下卷钩子`,
    resetPoint: null,
    openPayoffs: [],
    status: "active",
    sourceVersionId: null,
    chapters,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function createWorkspaceWithTitlesOnly(orders) {
  return buildVolumeWorkspaceDocument({
    novelId: "novel-demo",
    volumes: [
      createVolume(
        "volume-1",
        1,
        "第一卷",
        orders.map((order) => createTitleOnlyChapter(`chapter-${order}`, order)),
      ),
    ],
    beatSheets: [
      {
        volumeId: "volume-1",
        volumeSortOrder: 1,
        status: "generated",
        beats: [{
          key: "volume-1-beat",
          label: "卷一起势",
          summary: "卷一起势摘要",
          chapterSpanHint: `${orders[0]}-${orders[orders.length - 1]}章`,
          mustDeliver: ["卷一起势"],
        }],
      },
    ],
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildRequest(overrides = {}) {
  return {
    idea: "x",
    candidate: {
      id: "c1",
      workingTitle: "t",
      titleOptions: [],
      logline: "l",
      positioning: "p",
      sellingPoint: "s",
      coreConflict: "c",
      protagonistPath: "p",
      endingDirection: "e",
      hookStrategy: "h",
      progressionLoop: "p",
      whyItFits: "w",
      toneKeywords: [],
      targetChapterCount: 40,
    },
    runMode: "auto_to_execution",
    provider: "openai",
    model: "gpt-test",
    temperature: 0.4,
    ...overrides,
  };
}

function buildPreviousState(startOrder, endOrder) {
  return {
    enabled: true,
    mode: "chapter_range",
    firstChapterId: `chapter-${startOrder}`,
    startOrder,
    endOrder,
    totalChapterCount: endOrder - startOrder + 1,
    pipelineJobId: "job-old",
    pipelineStatus: "succeeded",
    autoReview: true,
    autoRepair: true,
    skippedChapterIds: ["chapter-skip"],
    skippedChapterOrders: [99],
    qualityDebtChapterIds: [],
    qualityDebtChapterOrders: [],
  };
}

function installPrismaResetMocks() {
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    transaction: prisma.$transaction,
  };
  prisma.chapter.findMany = async () => [];
  prisma.$transaction = async (callback) => callback({
    chapter: {
      updateMany: async () => ({ count: 0 }),
    },
    chapterSummary: { deleteMany: async () => ({ count: 0 }) },
    consistencyFact: { deleteMany: async () => ({ count: 0 }) },
    characterTimeline: { deleteMany: async () => ({ count: 0 }) },
    characterCandidate: { deleteMany: async () => ({ count: 0 }) },
    characterFactionTrack: { deleteMany: async () => ({ count: 0 }) },
    characterRelationStage: { deleteMany: async () => ({ count: 0 }) },
    qualityReport: { deleteMany: async () => ({ count: 0 }) },
    auditReport: { deleteMany: async () => ({ count: 0 }) },
    stateChangeProposal: { deleteMany: async () => ({ count: 0 }) },
    openConflict: { deleteMany: async () => ({ count: 0 }) },
    storyStateSnapshot: { deleteMany: async () => ({ count: 0 }) },
  });
  return () => {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.$transaction = originals.transaction;
  };
}

function withExecutionDetail(chapter) {
  const order = chapter.order;
  return {
    purpose: `第${order}章目标`,
    exclusiveEvent: `第${order}章独占事件`,
    endingState: `第${order}章结尾状态`,
    nextChapterEntryState: `第${order + 1}章入场状态`,
    conflictLevel: 5,
    revealLevel: 3,
    targetWordCount: 2500,
    mustAvoid: "不要展开无关支线",
    taskSheet: `第${order}章任务单`,
    sceneCards: createSceneCards(order),
    generationState: "planned",
    chapterStatus: "unplanned",
    content: "",
    ...chapter,
  };
}

test("prepareNextAutoExecutionBatch rejects non-reenter decision", async () => {
  await assert.rejects(
    () => prepareNextAutoExecutionBatch({
      volumeService: { getVolumes: async () => ({ volumes: [] }) },
      novelContextService: { listChapters: async () => [] },
    }, {
      novelId: "novel-demo",
      taskId: "task-1",
      decision: {
        kind: "expand_range",
        reason: "already ready",
        nextRange: { startOrder: 11, endOrder: 12 },
      },
      previousState: buildPreviousState(1, 10),
      previousRange: { startOrder: 1, endOrder: 10, totalChapterCount: 10, firstChapterId: "chapter-1" },
      request: buildRequest(),
    }),
    /仅接受 reenter_structured_outline/,
  );
});

test("prepareNextAutoExecutionBatch rejects missing request", async () => {
  await assert.rejects(
    () => prepareNextAutoExecutionBatch({
      volumeService: { getVolumes: async () => ({ volumes: [] }) },
      novelContextService: { listChapters: async () => [] },
    }, {
      novelId: "novel-demo",
      taskId: "task-1",
      decision: {
        kind: "reenter_structured_outline",
        reason: "need prepare",
        nextRange: { startOrder: 11, endOrder: 12 },
      },
      previousState: buildPreviousState(1, 10),
      previousRange: { startOrder: 1, endOrder: 10, totalChapterCount: 10, firstChapterId: "chapter-1" },
      request: null,
    }),
    /缺少 request/,
  );
});

test("prepareNextAutoExecutionBatch happy path details and expands next window", async () => {
  const restorePrisma = installPrismaResetMocks();
  const generateCalls = [];
  const syncCalls = [];
  const progressCalls = [];
  let workspace = createWorkspaceWithTitlesOnly([11, 12]);

  try {
    const result = await prepareNextAutoExecutionBatch({
      volumeService: {
        async getVolumes() {
          return clone(workspace);
        },
        async generateVolumes(_novelId, options) {
          generateCalls.push({
            scope: options.scope,
            detailMode: options.detailMode ?? null,
            targetChapterId: options.targetChapterId ?? null,
            chapterTaskSheetQualityMode: options.chapterTaskSheetQualityMode ?? null,
            entrypoint: options.entrypoint ?? null,
          });
          assert.equal(options.scope, "chapter_detail");
          assert.equal(options.entrypoint, "auto_director");
          assert.equal(options.chapterTaskSheetQualityMode, "ai_copilot");
          const next = clone(options.draftWorkspace ?? workspace);
          const chapter = next.volumes[0].chapters.find((item) => item.id === options.targetChapterId);
          assert.ok(chapter, "target chapter exists");
          Object.assign(chapter, createDetailedChapter(chapter.id, chapter.chapterOrder, chapter.volumeId));
          workspace = next;
          return clone(workspace);
        },
        async updateVolumesWithOptions(_novelId, document) {
          workspace = clone(document);
          return clone(workspace);
        },
        async syncVolumeChaptersWithOptions(_novelId, input, _options) {
          syncCalls.push(input.executionContractChapterRange ?? null);
          return { synced: true };
        },
      },
      novelContextService: {
        async listChapters() {
          return [11, 12].map((order) => withExecutionDetail({
            id: `chapter-${order}`,
            order,
          }));
        },
      },
      characterDynamicsService: {
        async rebuildDynamics() {
          return { ok: true };
        },
      },
      onProgress: async (label, progress) => {
        progressCalls.push([label, progress]);
      },
    }, {
      novelId: "novel-demo",
      taskId: "task-prepare",
      decision: {
        kind: "reenter_structured_outline",
        reason: "next window unprepared",
        nextRange: { startOrder: 11, endOrder: 12 },
      },
      previousState: buildPreviousState(1, 10),
      previousRange: {
        startOrder: 1,
        endOrder: 10,
        totalChapterCount: 10,
        firstChapterId: "chapter-1",
      },
      request: buildRequest(),
    });

    assert.equal(result.range.startOrder, 11);
    assert.equal(result.range.endOrder, 12);
    assert.equal(result.autoExecution.startOrder, 11);
    assert.equal(result.autoExecution.endOrder, 12);
    assert.equal(result.autoExecution.pipelineJobId, null);
    assert.equal(result.autoExecution.pipelineStatus, "queued");
    assert.ok(generateCalls.every((call) => call.scope === "chapter_detail"));
    assert.equal(generateCalls.length, 2);
    assert.ok(syncCalls.some((range) => range && range.startOrder === 11 && range.endOrder === 12));
    assert.ok(progressCalls.length > 0);
    // Debt fields from previousState are preserved via plan spread into state builder.
    assert.deepEqual(result.autoExecution.skippedChapterIds ?? [], ["chapter-skip"]);
  } finally {
    restorePrisma();
  }
});

test("prepareNextAutoExecutionBatch throws when recovery cursor stalls", async () => {
  const workspace = createWorkspaceWithTitlesOnly([21, 22]);
  await assert.rejects(
    () => prepareNextAutoExecutionBatch({
      volumeService: {
        async getVolumes() {
          return clone(workspace);
        },
        async generateVolumes(_novelId, options) {
          // Intentionally do not refine chapters → cursor must not advance.
          return clone(options.draftWorkspace ?? workspace);
        },
        async updateVolumesWithOptions(_novelId, document) {
          return clone(document);
        },
        async syncVolumeChaptersWithOptions() {
          return { synced: true };
        },
      },
      novelContextService: {
        async listChapters() {
          return [];
        },
      },
    }, {
      novelId: "novel-demo",
      taskId: "task-stall",
      decision: {
        kind: "reenter_structured_outline",
        reason: "need prepare",
        nextRange: { startOrder: 21, endOrder: 22 },
      },
      previousState: buildPreviousState(11, 20),
      previousRange: {
        startOrder: 11,
        endOrder: 20,
        totalChapterCount: 10,
        firstChapterId: "chapter-11",
      },
      request: buildRequest(),
    }),
    /恢复游标未推进/,
  );
});

test("prepareNextAutoExecutionBatch autopilot expands without chapter_detail generation", async () => {
  const restorePrisma = installPrismaResetMocks();
  const generateCalls = [];
  const workspace = createWorkspaceWithTitlesOnly([31, 32]);

  try {
    const result = await prepareNextAutoExecutionBatch({
      volumeService: {
        async getVolumes() {
          return clone(workspace);
        },
        async generateVolumes(_novelId, options) {
          generateCalls.push(options.scope);
          return clone(options.draftWorkspace ?? workspace);
        },
        async updateVolumesWithOptions(_novelId, document) {
          return clone(document);
        },
        async syncVolumeChaptersWithOptions() {
          return { synced: true };
        },
      },
      novelContextService: {
        async listChapters() {
          // Autopilot JIT: titles already listed as executable chapter rows.
          return [31, 32].map((order) => ({
            id: `chapter-${order}`,
            order,
            title: `第${order}章`,
            generationState: "planned",
            chapterStatus: "unplanned",
            content: "",
          }));
        },
      },
    }, {
      novelId: "novel-demo",
      taskId: "task-autopilot",
      decision: {
        kind: "reenter_structured_outline",
        reason: "lazy title window",
        nextRange: { startOrder: 31, endOrder: 32 },
      },
      previousState: buildPreviousState(21, 30),
      previousRange: {
        startOrder: 21,
        endOrder: 30,
        totalChapterCount: 10,
        firstChapterId: "chapter-21",
      },
      request: buildRequest({ runMode: "full_book_autopilot" }),
    });

    assert.equal(result.range.startOrder, 31);
    assert.equal(result.range.endOrder, 32);
    assert.deepEqual(generateCalls, []);
    assert.equal(result.autoExecution.pipelineStatus, "queued");
  } finally {
    restorePrisma();
  }
});

test("prepareNextAutoExecutionBatch autopilot throws when titles missing", async () => {
  // Schema requires title.min(1) at normalize time; strip after build so getVolumes
  // can still surface the runtime "title skeleton missing" branch.
  const emptyTitlesWorkspace = createWorkspaceWithTitlesOnly([41, 42]);
  emptyTitlesWorkspace.volumes[0].chapters.forEach((chapter) => {
    chapter.title = "   ";
  });

  await assert.rejects(
    () => prepareNextAutoExecutionBatch({
      volumeService: {
        async getVolumes() {
          return clone(emptyTitlesWorkspace);
        },
        async generateVolumes() {
          throw new Error("should not generate in autopilot title-missing path");
        },
        async updateVolumesWithOptions() {
          throw new Error("should not update");
        },
        async syncVolumeChaptersWithOptions() {
          throw new Error("should not sync");
        },
      },
      novelContextService: {
        async listChapters() {
          return [];
        },
      },
    }, {
      novelId: "novel-demo",
      taskId: "task-autopilot-missing",
      decision: {
        kind: "reenter_structured_outline",
        reason: "lazy window",
        nextRange: { startOrder: 41, endOrder: 42 },
      },
      previousState: buildPreviousState(31, 40),
      previousRange: {
        startOrder: 31,
        endOrder: 40,
        totalChapterCount: 10,
        firstChapterId: "chapter-31",
      },
      request: buildRequest({ runMode: "full_book_autopilot" }),
    }),
    /懒规划模式仍缺/,
  );
});
