const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");

const {
  ChapterExecutionContractService,
} = require("../dist/services/novel/volume/ChapterExecutionContractService.js");

const originalFindFirst = prisma.chapter.findFirst;

test.afterEach(() => {
  prisma.chapter.findFirst = originalFindFirst;
});

function buildChapter(overrides = {}) {
  return {
    id: "chapter-6",
    novelId: "novel-1",
    title: "第6章 交锋",
    order: 6,
    conflictLevel: 5,
    revealLevel: 3,
    targetWordCount: 2800,
    mustAvoid: "不要展开无关支线",
    taskSheet: "第6章任务单：推进主线冲突。",
    sceneCards: JSON.stringify({
      targetWordCount: 2800,
      lengthBudget: { targetWordCount: 2800, softMinWordCount: 2380, softMaxWordCount: 3220, hardMaxWordCount: 3500 },
      scenes: [
        { key: "c6-s1", title: "起势", purpose: "推进本章核心目标", mustAdvance: ["主线"], mustPreserve: ["人物动机"], entryState: "进入冲突", exitState: "压力升级", forbiddenExpansion: [], targetWordCount: 900 },
        { key: "c6-s2", title: "交锋", purpose: "制造选择压力", mustAdvance: ["冲突"], mustPreserve: ["设定边界"], entryState: "压力升级", exitState: "代价显形", forbiddenExpansion: [], targetWordCount: 900 },
        { key: "c6-s3", title: "落点", purpose: "形成章末推进", mustAdvance: ["章末钩子"], mustPreserve: ["后续入口"], entryState: "代价显形", exitState: "进入下一章", forbiddenExpansion: [], targetWordCount: 1000 },
      ],
    }),
    content: null,
    expectation: null,
    chapterStatus: "pending",
    generationState: null,
    repairHistory: null,
    qualityScore: null,
    continuityScore: null,
    characterScore: null,
    pacingScore: null,
    riskFlags: null,
    hook: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildWorkspace(planningFields = {}) {
  return {
    novelId: "novel-1",
    volumes: [
      {
        id: "volume-1",
        chapters: [
          {
            id: "volume-chapter-6",
            chapterOrder: 6,
            title: "第6章 交锋",
            purpose: "第6章目标",
            exclusiveEvent: "第6章独占事件",
            endingState: "第6章结尾状态",
            nextChapterEntryState: "第7章入场状态",
            ...planningFields,
          },
        ],
      },
    ],
  };
}

function buildStyleContract() {
  const sections = ["narrative", "character", "language", "rhythm", "antiAi", "selfCheck"];
  const contract = {};
  for (const key of sections) {
    const hasContent = key === "narrative";
    contract[key] = {
      key,
      title: key,
      lines: [],
      text: hasContent ? "风格合同文本" : "",
      hasContent,
    };
  }
  contract.meta = {
    activeSourceTargets: [],
    activeSourceLabels: [],
    writerIncludedSections: sections,
    plannerIncludedSections: sections,
    droppedSections: [],
    maturity: "structured",
    usesGlobalAntiAiBaseline: true,
    globalAntiAiRuleIds: [],
    styleAntiAiRuleIds: [],
  };
  return contract;
}

function buildDeps(workspace, styleContract = buildStyleContract()) {
  return {
    styleBindingService: {
      resolveForGeneration: async () => ({
        compiledBlocks: { contract: styleContract },
      }),
    },
    ensureVolumeWorkspace: async () => workspace,
    findVolumeChapterMatch: () => ({
      volumeId: "volume-1",
      volumeChapterId: "volume-chapter-6",
    }),
    ensureActiveVersionRecord: async () => {
      throw new Error("SENTINEL ensureActiveVersionRecord 不应在 reuse 路径被调用");
    },
    emitVolumeUpdated: () => {
      throw new Error("SENTINEL emitVolumeUpdated 不应在 reuse 路径被调用");
    },
  };
}

test("reuse 分支：卷文档四项规划字段齐全时复用合同，不再走持久化/重生成", async () => {
  prisma.chapter.findFirst = async () => buildChapter();

  const workspace = buildWorkspace();
  const service = new ChapterExecutionContractService(buildDeps(workspace));

  const result = await service.ensureChapterExecutionContract("novel-1", "chapter-6");

  assert.equal(result.id, "chapter-6");
  assert.equal(result.order, 6);
  assert.equal(result.taskSheet, "第6章任务单：推进主线冲突。");
  assert.equal(result.styleContract, "风格合同文本");
});

test("reuse 分支：卷文档规划字段任一缺失时落穿到重生成（不复用）", async () => {
  prisma.chapter.findFirst = async () => buildChapter();

  // nextChapterEntryState 缺失 → planningFieldsComplete 应为 false → 落穿到重生成
  const workspace = buildWorkspace({ nextChapterEntryState: null });
  const service = new ChapterExecutionContractService(buildDeps(workspace));

  // 落穿路径会调用真实 generateVolumePlanDocument（硬依赖、无法注入），在单元测试下必抛，
  // 而不会走 reuse 提前返回（提前返回会命中 SENTINEL 断言）。
  await assert.rejects(
    () => service.ensureChapterExecutionContract("novel-1", "chapter-6"),
    (err) => {
      // 关键：若误走 reuse 会抛出 SENTINEL；否则是重生成路径的真实失败
      assert.notEqual(err.message, "SENTINEL ensureActiveVersionRecord 不应在 reuse 路径被调用");
      assert.notEqual(err.message, "SENTINEL emitVolumeUpdated 不应在 reuse 路径被调用");
      return true;
    },
  );
});