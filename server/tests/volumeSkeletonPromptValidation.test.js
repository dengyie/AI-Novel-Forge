const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createVolumeSkeletonPrompt,
} = require("../dist/prompting/prompts/novel/volume/skeleton.prompts.js");
const {
  volumeBeatSheetPrompt,
} = require("../dist/prompting/prompts/novel/volume/beatSheet.prompts.js");
const {
  volumeChapterTaskSheetPrompt,
  volumeChapterExecutionContractPrompt,
} = require("../dist/prompting/prompts/novel/volume/chapterDetail.prompts.js");

function renderSystemText(asset, input, context) {
  const messages = asset.render(input, context);
  const system = messages.find((message) => message._getType() === "system");
  return system?.content ?? "";
}

function emptyContext() {
  return {
    blocks: [],
    selectedBlockIds: [],
    droppedBlockIds: [],
    summarizedBlockIds: [],
    estimatedInputTokens: 0,
  };
}

function buildSkeletonInput() {
  return {
    novel: {
      title: "测试小说",
      description: null,
      targetAudience: null,
      bookSellingPoint: null,
      competingFeel: null,
      first30ChapterPromise: null,
      commercialTagsJson: null,
      estimatedChapterCount: 300,
      narrativePov: null,
      pacePreference: null,
      emotionIntensity: null,
      storyModePromptBlock: null,
      genre: null,
      characters: [],
    },
    workspace: {
      novelId: "novel-1",
      workspaceVersion: "v2",
      volumes: [],
      strategyPlan: null,
      critiqueReport: null,
      beatSheets: [],
      rebalanceDecisions: [],
      readiness: {},
      source: "volume",
      activeVersionId: null,
    },
    storyMacroPlan: null,
    strategyPlan: null,
    guidance: undefined,
    volumeCountGuidance: {
      chapterBudget: 300,
      targetChapterRange: { min: 20, max: 60, ideal: 40 },
      allowedVolumeCountRange: { min: 1, max: 8 },
      systemRecommendedVolumeCount: 4,
      recommendedVolumeCount: 4,
      hardPlannedVolumeRange: { min: 1, max: 4 },
      userPreferredVolumeCount: null,
      respectedExistingVolumeCount: null,
    },
    chapterBudget: 300,
  };
}

test("createVolumeSkeletonPrompt SystemMessage contains opponent-focus constraints", () => {
  const prompt = createVolumeSkeletonPrompt(4);
  const systemText = renderSystemText(prompt, buildSkeletonInput(), emptyContext());
  assert.match(systemText, /对手面 \/ 主压迫源约束/);
  assert.match(systemText, /聚焦具体小圈层/);
  assert.match(systemText, /绝大多数人中立/);
  assert.match(systemText, /全世界针对主角/);
});

test("createVolumeSkeletonPrompt SystemMessage bans mechanical-measurement framing (称重)", () => {
  const prompt = createVolumeSkeletonPrompt(4);
  const systemText = renderSystemText(prompt, buildSkeletonInput(), emptyContext());
  assert.match(systemText, /称重/);
  assert.match(systemText, /机械度量隐喻/);
});

test("createVolumeSkeletonPrompt SystemMessage requires focused-local per volume", () => {
  const prompt = createVolumeSkeletonPrompt(4);
  const systemText = renderSystemText(prompt, buildSkeletonInput(), emptyContext());
  assert.match(systemText, /focused-local/);
  assert.match(systemText, /集体站队/);
});

test("volumeBeatSheetPrompt SystemMessage keeps pressure focused-local (no abstract collective upgrade)", () => {
  const input = {
    ...buildSkeletonInput(),
    targetVolume: {
      id: "volume-2",
      novelId: "novel-1",
      sortOrder: 2,
      title: "第二卷",
      summary: "摘要",
      openingHook: "开卷抓手",
      mainPromise: "主承诺",
      primaryPressureSource: "压力源",
      coreSellingPoint: "核心卖点",
      escalationMode: "升级方式",
      protagonistChange: "主角变化",
      midVolumeRisk: "中段风险",
      climax: "高潮",
      payoffType: "兑现",
      nextVolumeHook: "下卷钩子",
      resetPoint: null,
      openPayoffs: [],
      status: "active",
      sourceVersionId: null,
      chapters: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    targetChapterCount: 40,
    detailMode: "task_sheet",
  };
  const systemText = renderSystemText(volumeBeatSheetPrompt, input, emptyContext());
  assert.match(systemText, /focused-local/);
  assert.match(systemText, /集体站队/);
  // beatSheet must not repeat「称重」literal as a normal term — it shouldn't appear at all.
  assert.equal(systemText.includes("称重"), false, "beatSheet prompt must not introduce「称重」literal");
});

test("volumeChapterTaskSheetPrompt SystemMessage uses named-opponent scene pressure, bans abstract collective", () => {
  const targetVolume = {
    id: "volume-2",
    novelId: "novel-1",
    sortOrder: 2,
    title: "第二卷",
    summary: "摘要",
    openingHook: "开卷抓手",
    mainPromise: "主承诺",
    primaryPressureSource: "压力源",
    coreSellingPoint: "核心卖点",
    escalationMode: "升级方式",
    protagonistChange: "主角变化",
    midVolumeRisk: "中段风险",
    climax: "高潮",
    payoffType: "兑现",
    nextVolumeHook: "下卷钩子",
    resetPoint: null,
    openPayoffs: [],
    status: "active",
    sourceVersionId: null,
    chapters: [{
      id: "chapter-1",
      chapterOrder: 1,
      title: "第一章",
      summary: "摘要",
      purpose: "目的",
      exclusiveEvent: "独占事件",
      endingState: "结束态",
      nextChapterEntryState: "下章入口",
      conflictLevel: 30,
      conflictLevelSource: "ai",
      revealLevel: 10,
      targetWordCount: 3000,
      mustAvoid: "禁止",
      payoffRefs: [],
      functionIds: [],
      taskSheet: "执行指令",
      sceneCards: "[]",
    }],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const input = {
    ...buildSkeletonInput(),
    targetVolume,
    targetBeatSheet: null,
    targetChapter: targetVolume.chapters[0],
    detailMode: "task_sheet",
  };
  const systemText = renderSystemText(volumeChapterTaskSheetPrompt, input, emptyContext());
  assert.match(systemText, /现场压力/);
  assert.match(systemText, /具名小圈层对手/);
  assert.match(systemText, /抽象群体压力/);
  // 机械度量隐喻禁用条款应出现在 task_sheet 系统提示中
  assert.match(systemText, /机械度量隐喻/);
});

test("volumeChapterExecutionContractPrompt SystemMessage keeps opponent-focus on scene pressure", () => {
  const targetVolume = {
    id: "volume-2",
    novelId: "novel-1",
    sortOrder: 2,
    title: "第二卷",
    summary: "摘要",
    openingHook: "开卷抓手",
    mainPromise: "主承诺",
    primaryPressureSource: "压力源",
    coreSellingPoint: "核心卖点",
    escalationMode: "升级方式",
    protagonistChange: "主角变化",
    midVolumeRisk: "中段风险",
    climax: "高潮",
    payoffType: "兑现",
    nextVolumeHook: "下卷钩子",
    resetPoint: null,
    openPayoffs: [],
    status: "active",
    sourceVersionId: null,
    chapters: [{
      id: "chapter-1",
      chapterOrder: 1,
      title: "第一章",
      summary: "摘要",
      purpose: "目的",
      exclusiveEvent: "独占事件",
      endingState: "结束态",
      nextChapterEntryState: "下章入口",
      conflictLevel: 30,
      conflictLevelSource: "ai",
      revealLevel: 10,
      targetWordCount: 3000,
      mustAvoid: "禁止",
      payoffRefs: [],
      functionIds: [],
      taskSheet: "执行指令",
      sceneCards: "[]",
    }],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const input = {
    ...buildSkeletonInput(),
    targetVolume,
    targetBeatSheet: null,
    targetChapter: targetVolume.chapters[0],
    detailMode: "task_sheet",
  };
  const systemText = renderSystemText(volumeChapterExecutionContractPrompt, input, emptyContext());
  assert.match(systemText, /具名小圈层对手/);
  assert.match(systemText, /抽象群体压力/);
});
