const test = require("node:test");
const assert = require("node:assert/strict");

// 生成侧共享分类器 + marker
const {
  CONTRACT_REPLAN_WINDOW_MARKER,
  isReplanWindowRequired,
} = require("../../shared/dist/types/chapterTaskSheetQuality.js");

// 失败链分类器
const {
  isContractReplanWindowFailure,
  isSkippableAutoExecutionReviewFailure,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionFailure.js");

// 生成侧专属错误持 marker
const {
  ChapterExecutionContractReplanWindowError,
} = require("../dist/services/novel/volume/volumeGenerationHelpers.js");

// 自动重排运行时（失败处理器委托的核心：window_replan 预算记账 + 调 replanNovel）
const {
  runFullBookAutopilotReplanNotice,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionCircuitBreakerRuntime.js");

// ---- 纯分类器 ----

test("isReplanWindowRequired 只在 issues 含 contract_overloaded 时为真", () => {
  const replanResult = {
    canEnterExecution: false,
    issues: [
      { id: "contract_overloaded", severity: "high", reason: "章节职责过载" },
    ],
  };
  assert.equal(isReplanWindowRequired(replanResult), true);

  const repairResult = {
    canEnterExecution: false,
    issues: [
      { id: "task_sheet_incoherent", severity: "high", reason: "任务片前后矛盾" },
    ],
  };
  assert.equal(isReplanWindowRequired(repairResult), false);

  const noIssue = { canEnterExecution: true, issues: [] };
  assert.equal(isReplanWindowRequired(noIssue), false);
});

test("CONTRACT_REPLAN_WINDOW_MARKER 用于生成侧与失败侧共用", () => {
  assert.equal(CONTRACT_REPLAN_WINDOW_MARKER, "[contract_replan_window]");
});

test("isContractReplanWindowFailure 识别 marker，且不误伤 skippable-review 哨兵串", () => {
  const replanMessage = `${CONTRACT_REPLAN_WINDOW_MARKER} 章节执行合同职责过载，需整窗重排`;
  assert.equal(isContractReplanWindowFailure(replanMessage), true);
  assert.equal(isContractReplanWindowFailure("Chapter execution contract failed for quality reasons"), false);
  assert.equal(isContractReplanWindowFailure(null), false);
  assert.equal(isContractReplanWindowFailure(""), false);

  // skippable-review 哨兵串不应被当成 replan_window（两条分类互斥）
  const skippableMessage = "Chapter generation is blocked until review is resolved.";
  assert.equal(isSkippableAutoExecutionReviewFailure(skippableMessage), true);
  assert.equal(isContractReplanWindowFailure(skippableMessage), false);
});

test("ChapterExecutionContractReplanWindowError 携带 marker 且被失败侧分类器识别", () => {
  const gateResult = {
    canEnterExecution: false,
    issues: [{ id: "contract_overloaded", severity: "high", reason: "章节职责过载" }],
  };
  const err = new ChapterExecutionContractReplanWindowError(
    gateResult,
    "章节执行合同职责过载，需整窗重排",
  );
  assert.equal(err.name, "ChapterExecutionContractReplanWindowError");
  assert.equal(err.gateResult, gateResult);
  assert.match(err.message, /\[contract_replan_window\]/);
  assert.equal(isContractReplanWindowFailure(err.message), true);
});

// reuse 分支（reuse 在卷文档规划字段缺失时落穿再生成）由 chapterExecutionContractReuse.test.js 覆盖，
// 本文件聚焦 replan_window 分类器与自动重排预算记账逻辑。

// ---- runFullBookAutopilotReplanNotice 预算记账 + 自动重排 ----

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
    nextChapterId: "chapter-6",
    nextChapterOrder: 6,
    remainingChapterIds: ["chapter-6", "chapter-7", "chapter-8"],
    remainingChapterOrders: [6, 7, 8],
    ...overrides,
  };
}

function buildDeps() {
  const calls = { replanNovel: [] };
  return {
    deps: {
      replanNovel: async (novelId, input) => { calls.replanNovel.push({ novelId, input }); },
      workflowService: {
        markTaskFailed: async () => {},
      },
      automationLedgerEventService: {
        recordEvent: async () => {},
        recordCircuitBreakerOpened: async () => {},
      },
    },
    calls,
  };
}

test("replan_window 失败首次触发自动重排并返回 continue", async () => {
  const { deps, calls } = buildDeps();
  const request = buildRequest();
  const autoExecution = buildAutoExecution({ qualityDebtSummaries: null });

  const result = await runFullBookAutopilotReplanNotice({
    deps,
    taskId: "task-1",
    novelId: "novel-1",
    request,
    range: { totalChapterCount: 10, startOrder: 1, endOrder: 10 },
    autoExecution,
    checkpointState: autoExecution,
    noticeSummary: `${CONTRACT_REPLAN_WINDOW_MARKER} 章节执行合同职责过载，需整窗重排`,
  });

  assert.equal(result.stopped, false);
  assert.equal(result.decision, "auto_replan_window");
  assert.equal(calls.replanNovel.length, 1);
  assert.equal(calls.replanNovel[0].novelId, "novel-1");
  assert.equal(calls.replanNovel[0].input.triggerType, "contract_replan_window");
  assert.equal(calls.replanNovel[0].input.chapterId, "chapter-6");
  // 重排后的 autoExecution 带上了预算记账（windowReplan 用了一次）
  assert.ok(result.autoExecution?.qualityLoopLedger, "重排后应写入 qualityLoopLedger");
});

test("同签名第二次 replan_window 失败预算耗尽，不再重排而回退 defer_and_continue", async () => {
  const { deps, calls } = buildDeps();
  const request = buildRequest();
  let state = buildAutoExecution({ qualityDebtSummaries: null });

  // 第一次：触发一次 replan
  const first = await runFullBookAutopilotReplanNotice({
    deps,
    taskId: "task-1",
    novelId: "novel-1",
    request,
    range: { totalChapterCount: 10, startOrder: 1, endOrder: 10 },
    autoExecution: state,
    checkpointState: state,
    noticeSummary: `${CONTRACT_REPLAN_WINDOW_MARKER} 章节执行合同职责过载，需整窗重排`,
  });
  assert.equal(first.decision, "auto_replan_window");
  assert.equal(calls.replanNovel.length, 1);
  state = first.autoExecution;

  // 第二次：同一签名（windowReplan 预算 = 1 已耗尽）→ 不再 replan，defer 后再触发会继续
  const second = await runFullBookAutopilotReplanNotice({
    deps,
    taskId: "task-1",
    novelId: "novel-1",
    request,
    range: { totalChapterCount: 10, startOrder: 1, endOrder: 10 },
    autoExecution: state,
    checkpointState: state,
    noticeSummary: `${CONTRACT_REPLAN_WINDOW_MARKER} 章节执行合同职责过载，需整窗重排`,
  });

  assert.equal(second.stopped, false);
  assert.equal(second.decision, "defer_and_continue");
  // 关键断言：预算耗尽后 replanNovel 不能再被调用
  assert.equal(calls.replanNovel.length, 1);
});