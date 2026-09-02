const test = require("node:test");
const assert = require("node:assert/strict");

const { repairDirectorChapterTitles } = require("../dist/services/novel/director/phases/novelDirectorChapterTitleRepair.js");

function createRequest() {
  return {
    runMode: "auto_to_ready",
    provider: "deepseek",
    model: "deepseek-chat",
    temperature: 0.7,
    candidate: {
      workingTitle: "都市神医：我的病人都是大佬",
    },
  };
}

function createVolume(id, sortOrder, titles) {
  return {
    id,
    sortOrder,
    title: `第${sortOrder}卷`,
    summary: "",
    openingHook: "",
    mainPromise: "",
    primaryPressureSource: "",
    coreSellingPoint: "",
    escalationMode: "",
    protagonistChange: "",
    midVolumeRisk: "",
    climax: "",
    payoffType: "",
    nextVolumeHook: "",
    resetPoint: "",
    openPayoffs: [],
    chapters: titles.map((title, index) => ({
      id: `${id}-chapter-${index + 1}`,
      chapterOrder: index + 1,
      title,
      summary: `第 ${index + 1} 章摘要`,
      purpose: "",
      targetWordCount: null,
      conflictLevel: null,
      revealLevel: null,
      mustAvoid: "",
      taskSheet: "",
      sceneCards: null,
      payoffRefs: [],
    })),
  };
}

test("repairDirectorChapterTitles clears warning notice after titles are diversified", async () => {
  const baseWorkspace = {
    novelId: "novel_demo",
    workspaceVersion: "v2",
    source: "volume",
    activeVersionId: "version-1",
    derivedOutline: "",
    derivedStructuredOutline: "",
    readiness: {},
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [{
      volumeId: "volume-1",
      volumeSortOrder: 1,
      status: "generated",
      beats: [{
        key: "open_hook",
        label: "开卷抓手",
        summary: "建立开篇危机。",
        chapterSpanHint: "1-4章",
        mustDeliver: ["开篇压力"],
      }],
    }],
    rebalanceDecisions: [],
    volumes: [
      createVolume("volume-1", 1, [
        "医院的秘密1",
        "医院的秘密2",
        "医院的秘密3",
        "医院的秘密4",
      ]),
    ],
  };
  const repairedWorkspace = {
    ...baseWorkspace,
    volumes: [
      createVolume("volume-1", 1, [
        "第一位大佬在诊室醒来",
        "诊室门口突然排起长队",
        "这张化验单藏着第二层危机",
        "他当场改口，要把整栋楼送我",
      ]),
    ],
  };

  const markTaskRunningCalls = [];
  const markTaskWaitingApprovalCalls = [];
  const volumeService = {
    getVolumes: async () => baseWorkspace,
    generateVolumes: async (_novelId, options) => {
      await options.onPhaseStart?.({
        scope: "chapter_list",
        phase: "load_context",
        label: "",
      });
      return repairedWorkspace;
    },
    updateVolumes: async () => repairedWorkspace,
  };
  const workflowService = {
    getTaskByIdWithoutHealing: async () => null,
    markTaskRunning: async (_taskId, payload) => {
      markTaskRunningCalls.push(payload);
    },
    markTaskWaitingApproval: async (_taskId, payload) => {
      markTaskWaitingApprovalCalls.push(payload);
    },
  };

  await repairDirectorChapterTitles({
    taskId: "task-1",
    novelId: "novel_demo",
    targetVolumeId: "volume-1",
    request: createRequest(),
    volumeService,
    workflowService,
    buildDirectorSeedPayload: (_request, novelId, extra) => ({
      novelId,
      ...extra,
    }),
  });

  assert.equal(markTaskRunningCalls.length, 1);
  assert.match(markTaskRunningCalls[0].itemLabel, /整理第 1 卷拆章上下文/);
  assert.equal(markTaskWaitingApprovalCalls.length, 1);
  assert.equal(markTaskWaitingApprovalCalls[0].volumeId, "volume-1");
  assert.equal(markTaskWaitingApprovalCalls[0].clearCheckpoint, true);
  assert.equal(markTaskWaitingApprovalCalls[0].seedPayload.taskNotice, null);
});

test("repairDirectorChapterTitles regenerates all beats involved in multi-pair duplicates without deadlocking", async () => {
  // 测试卷包含 4 个 beat，含两对独立重复标题（A & B 重复「夜巡」，C & D 重复「雨夜」）
  const beats = [
    { key: "beat_a", label: "段落A", summary: "", chapterSpanHint: "1-1章", mustDeliver: [] },
    { key: "beat_b", label: "段落B", summary: "", chapterSpanHint: "2-2章", mustDeliver: [] },
    { key: "beat_c", label: "段落C", summary: "", chapterSpanHint: "3-3章", mustDeliver: [] },
    { key: "beat_d", label: "段落D", summary: "", chapterSpanHint: "4-4章", mustDeliver: [] },
  ];
  const baseWorkspace = {
    novelId: "novel_demo",
    workspaceVersion: "v2",
    source: "volume",
    activeVersionId: "version-1",
    derivedOutline: "",
    derivedStructuredOutline: "",
    readiness: {},
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [{
      volumeId: "volume-1",
      volumeSortOrder: 1,
      status: "generated",
      beats,
    }],
    rebalanceDecisions: [],
    volumes: [
      createVolume("volume-1", 1, [
        "夜巡",
        "夜巡",
        "雨夜",
        "雨夜",
      ]),
    ],
  };

  const regeneratedBeatKeys = [];
  let currentWorkspace = baseWorkspace;
  const volumeService = {
    getVolumes: async () => baseWorkspace,
    generateVolumes: async (_novelId, options) => {
      regeneratedBeatKeys.push(options.targetBeatKey);
      assert.equal(options.generationMode, "single_beat");
      // 模拟每次 single_beat 重生成给当前 beat 换上唯一新标题
      const newTitlesByBeat = {
        beat_a: "破晓追凶",
        beat_b: "晨光显现",
        beat_c: "暗流涌动",
        beat_d: "落幕对决",
      };
      const beatIndex = beats.findIndex((b) => b.key === options.targetBeatKey);
      const updatedChapters = currentWorkspace.volumes[0].chapters.map((ch, idx) => {
        if (idx === beatIndex) {
          return { ...ch, title: newTitlesByBeat[options.targetBeatKey] || ch.title };
        }
        return ch;
      });
      currentWorkspace = {
        ...currentWorkspace,
        volumes: [{
          ...currentWorkspace.volumes[0],
          chapters: updatedChapters,
        }],
      };
      return currentWorkspace;
    },
    updateVolumes: async (_novelId, payload) => {
      assert.equal(payload.syncToChapterExecution, true);
      return currentWorkspace;
    },
  };
  const workflowService = {
    getTaskByIdWithoutHealing: async () => null,
    markTaskRunning: async () => undefined,
    markTaskWaitingApproval: async () => undefined,
  };

  await repairDirectorChapterTitles({
    taskId: "task-multi-dup",
    novelId: "novel_demo",
    targetVolumeId: "volume-1",
    request: createRequest(),
    volumeService,
    workflowService,
    buildDirectorSeedPayload: (_request, novelId, extra) => ({
      novelId,
      ...extra,
    }),
  });

  // 必须把所有涉及重复对的 beat（beat_a, beat_b, beat_c, beat_d）全部纳入重生成
  assert.deepEqual(regeneratedBeatKeys.sort(), ["beat_a", "beat_b", "beat_c", "beat_d"].sort());
  // 最终所有章节标题均应唯一
  const finalTitles = currentWorkspace.volumes[0].chapters.map((ch) => ch.title);
  assert.equal(new Set(finalTitles).size, 4);
});

test.skip("repairDirectorChapterTitles keeps warning notice when repaired titles are still too concentrated", { skip: "Semantic title-diversity retry policy is pending a deterministic non-LLM fixture." }, async () => {
  const repetitiveTitles = Array.from({ length: 10 }, (_, index) => `医院的秘密${index + 1}`);
  const workspace = {
    novelId: "novel_demo",
    workspaceVersion: "v2",
    source: "volume",
    activeVersionId: "version-1",
    derivedOutline: "",
    derivedStructuredOutline: "",
    readiness: {},
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [{
      volumeId: "volume-1",
      volumeSortOrder: 1,
      status: "generated",
      beats: [{
        key: "open_hook",
        label: "开卷抓手",
        summary: "建立开篇危机。",
        chapterSpanHint: "1-4章",
        mustDeliver: ["开篇压力"],
      }],
    }],
    rebalanceDecisions: [],
    volumes: [
      createVolume("volume-1", 1, repetitiveTitles),
    ],
  };

  const markTaskWaitingApprovalCalls = [];
  const volumeService = {
    getVolumes: async () => workspace,
    generateVolumes: async () => workspace,
    updateVolumes: async () => workspace,
  };
  const workflowService = {
    getTaskByIdWithoutHealing: async () => null,
    markTaskRunning: async () => undefined,
    markTaskWaitingApproval: async (_taskId, payload) => {
      markTaskWaitingApprovalCalls.push(payload);
    },
  };

  await repairDirectorChapterTitles({
    taskId: "task-2",
    novelId: "novel_demo",
    targetVolumeId: "volume-1",
    request: createRequest(),
    volumeService,
    workflowService,
    buildDirectorSeedPayload: (_request, novelId, extra) => ({
      novelId,
      ...extra,
    }),
  });

  assert.equal(markTaskWaitingApprovalCalls.length, 1);
  assert.equal(markTaskWaitingApprovalCalls[0].seedPayload.taskNotice.code, "CHAPTER_TITLE_DIVERSITY");
  assert.equal(markTaskWaitingApprovalCalls[0].seedPayload.taskNotice.action.volumeId, "volume-1");
});
