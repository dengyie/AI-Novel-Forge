const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONTRACT_REPLAN_WINDOW_MARKER,
} = require("../../shared/dist/types/chapterTaskSheetQuality.js");

const {
  handleAutoExecutionFailure,
} = require("../dist/services/novel/director/automation/application/AutoExecutionFailureHandler.js");

const {
  buildDirectorQualityLoopBudgetWindow,
  buildDirectorQualityLoopIssueSignature,
  recordDirectorQualityLoopBudgetAttempt,
} = require("../dist/services/novel/director/runtime/DirectorQualityLoopBudgetLedgerService.js");

// ---- helpers ----

function buildRequest(overrides = {}) {
  return {
    idea: "命运迷局",
    candidate: {
      id: "candidate-1",
      workingTitle: "命运迷局",
      titleOptions: [],
      logline: "一个普通人误入更大的秘密链条。",
      positioning: "都市悬疑成长",
      sellingPoint: "强钩子与高压追更感",
      coreConflict: "主角必须在真相与自保之间抉择",
      protagonistPath: "从被动卷入到主动破局",
      endingDirection: "主角以代价换来新秩序",
      hookStrategy: "用反常事件做开局钩子",
      progressionLoop: "调查推进、反噬升级",
      whyItFits: "适合自动导演快速启动",
      toneKeywords: ["悬疑"],
      targetChapterCount: 20,
    },
    runMode: "full_book_autopilot",
    provider: "test-provider",
    model: "test-model",
    temperature: 0.5,
    ...overrides,
  };
}

function buildAutoExecution(overrides = {}) {
  return {
    enabled: true,
    mode: "book",
    autoReview: true,
    autoRepair: true,
    startOrder: 1,
    endOrder: 10,
    totalChapterCount: 10,
    firstChapterId: "chapter-1",
    nextChapterId: "chapter-6",
    nextChapterOrder: 6,
    remainingChapterIds: ["chapter-6", "chapter-7", "chapter-8"],
    remainingChapterOrders: [6, 7, 8],
    ...overrides,
  };
}

function buildRange() {
  return { startOrder: 1, endOrder: 10, totalChapterCount: 10, firstChapterId: "chapter-1" };
}

function buildJob(errorMessage) {
  return {
    id: "job-1",
    status: "failed",
    error: errorMessage,
    progress: 0,
    payload: null,
  };
}

function buildProgressGuard() {
  return { consecutiveNoProgress: 0, shouldStop: false };
}

function buildSceneCards(order) {
  return JSON.stringify({
    targetWordCount: 2800,
    lengthBudget: {
      targetWordCount: 2800,
      softMinWordCount: 2380,
      softMaxWordCount: 3220,
      hardMaxWordCount: 3500,
    },
    scenes: [
      {
        key: `chapter-${order}-scene-1`,
        title: "起势",
        purpose: "推进本章核心目标",
        mustAdvance: ["主线"],
        mustPreserve: ["人物动机"],
        entryState: "进入冲突",
        exitState: "压力升级",
        forbiddenExpansion: [],
        targetWordCount: 900,
      },
      {
        key: `chapter-${order}-scene-2`,
        title: "交锋",
        purpose: "制造选择压力",
        mustAdvance: ["冲突"],
        mustPreserve: ["设定边界"],
        entryState: "压力升级",
        exitState: "代价显形",
        forbiddenExpansion: [],
        targetWordCount: 900,
      },
      {
        key: `chapter-${order}-scene-3`,
        title: "落点",
        purpose: "形成章末推进",
        mustAdvance: ["章末钩子"],
        mustPreserve: ["后续入口"],
        entryState: "代价显形",
        exitState: "进入下一章",
        forbiddenExpansion: [],
        targetWordCount: 1000,
      },
    ],
  });
}

function withExecutionDetail(chapter) {
  const order = chapter.order ?? chapter.chapterOrder ?? 1;
  return {
    purpose: `第${order}章目标`,
    exclusiveEvent: `第${order}章独占事件`,
    endingState: `第${order}章结尾状态`,
    nextChapterEntryState: `第${order + 1}章入场状态`,
    conflictLevel: 5,
    revealLevel: 3,
    targetWordCount: 2800,
    mustAvoid: "不要展开无关支线",
    taskSheet: `第${order}章任务单`,
    sceneCards: buildSceneCards(order),
    ...chapter,
  };
}

function buildChapters() {
  const chapters = [];
  for (let order = 1; order <= 5; order += 1) {
    chapters.push({
      id: `chapter-${order}`,
      order,
      generationState: "approved",
      chapterStatus: "completed",
      content: `正文${order}`,
    });
  }
  for (const order of [6, 7, 8]) {
    chapters.push(withExecutionDetail({
      id: `chapter-${order}`,
      order,
      generationState: "planned",
      chapterStatus: "unplanned",
      content: "",
    }));
  }
  return chapters;
}

function buildDeps() {
  const calls = { replanNovel: [], markTaskFailed: [], recordEvent: [], bootstrapTask: [] };
  return {
    deps: {
      novelContextService: {
        async listChapters() {
          return buildChapters();
        },
      },
      workflowService: {
        async bootstrapTask(input) {
          calls.bootstrapTask.push(input);
        },
        async getTaskById() {
          return { status: "running" };
        },
        async markTaskRunning() {},
        async recordCheckpoint() {},
        async markTaskFailed(taskId, message, patch) {
          calls.markTaskFailed.push({ taskId, message, patch });
        },
      },
      buildDirectorSeedPayload(_request, _novelId, extra) {
        return extra ?? {};
      },
      replanNovel: async (novelId, input) => {
        calls.replanNovel.push({ novelId, input });
      },
      automationLedgerEventService: {
        async recordEvent(event) {
          calls.recordEvent.push(event);
        },
        async recordRepairTicketCreated() {},
        async recordCircuitBreakerOpened() {},
      },
    },
    calls,
  };
}

// ---- 测试 ----

test("replan_window 失败首次触发自动重排并返回 continue", async () => {
  const { deps, calls } = buildDeps();
  const request = buildRequest();
  const autoExecution = buildAutoExecution({ qualityDebtSummaries: null });
  const range = buildRange();
  const failureMessage = `${CONTRACT_REPLAN_WINDOW_MARKER} 章节执行合同职责过载，需整窗重排`;

  const result = await handleAutoExecutionFailure({
    deps,
    taskId: "task-1",
    novelId: "novel-1",
    request,
    range,
    autoExecution,
    pipelineJobId: "job-1",
    job: buildJob(failureMessage),
    allowLazyChapterPlanning: true,
    progressGuard: buildProgressGuard(),
    maxConsecutiveNoProgress: 3,
    resolveQualityIssueChapter: async () => null,
  });

  assert.equal(result.kind, "continue");
  // replanNovel 应被调用一次，携带 contract_replan_window triggerType
  assert.equal(calls.replanNovel.length, 1);
  assert.equal(calls.replanNovel[0].novelId, "novel-1");
  assert.equal(calls.replanNovel[0].input.triggerType, "contract_replan_window");
  assert.equal(calls.replanNovel[0].input.chapterId, "chapter-6");
  // 返回的 autoExecution 应包含更新后的状态（有剩余章节）
  assert.ok(result.autoExecution.remainingChapterCount > 0);
  // 未触发停等相关调用
  assert.equal(calls.markTaskFailed.length, 0);
});

test("同签名第二次 replan_window 失败预算耗尽，不再重排而回退停等", async () => {
  const { deps, calls } = buildDeps();
  const request = buildRequest();
  const range = buildRange();
  const failureMessage = `${CONTRACT_REPLAN_WINDOW_MARKER} 章节执行合同职责过载，需整窗重排`;

  // 用 budget ledger 构造已耗尽 windowReplan 预算的 autoExecution。
  // 确保 issueSignature 与 runFullBookAutopilotReplanNotice 内部计算一致。
  const window = buildDirectorQualityLoopBudgetWindow({
    autoExecution: buildAutoExecution({ qualityDebtSummaries: null }),
    chapterId: "chapter-6",
    chapterOrder: 6,
  });
  const issueSignature = buildDirectorQualityLoopIssueSignature({
    reason: failureMessage,
    noticeCode: undefined,
    riskLevel: undefined,
    repairMode: undefined,
  });
  const seeded = recordDirectorQualityLoopBudgetAttempt({
    state: buildAutoExecution({ qualityDebtSummaries: null }),
    novelId: "novel-1",
    taskId: "task-1",
    issueSignature,
    affectedChapterWindow: window,
    action: "window_replan",
    reason: failureMessage,
    chapterId: "chapter-6",
    chapterOrder: 6,
  });

  const result = await handleAutoExecutionFailure({
    deps,
    taskId: "task-1",
    novelId: "novel-1",
    request,
    range,
    autoExecution: seeded.state,
    pipelineJobId: "job-1",
    job: buildJob(failureMessage),
    allowLazyChapterPlanning: true,
    progressGuard: buildProgressGuard(),
    maxConsecutiveNoProgress: 3,
    resolveQualityIssueChapter: async () => null,
  });

  assert.equal(result.kind, "stop");
  // 预算耗尽后 replanNovel 不能再被调用
  assert.equal(calls.replanNovel.length, 0);
  // 应触发 markTaskFailed（而非 continue_with_risk 事件）
  assert.ok(calls.markTaskFailed.length >= 1);
  assert.match(calls.markTaskFailed[0].message, /重排预算已耗尽/);
  assert.equal(calls.markTaskFailed[0].patch.checkpointType, "replan_required");
  // 不应有 continue_with_risk 事件
  assert.equal(
    calls.recordEvent.filter((e) => e.type === "continue_with_risk").length,
    0,
  );
});