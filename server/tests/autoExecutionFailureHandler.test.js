const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONTRACT_REPLAN_WINDOW_MARKER,
  buildContractIssueDescriptor,
} = require("../../shared/dist/types/chapterTaskSheetQuality.js");

// 失败处理器（含 replan_window → 自动重排接线 + defer_and_continue 保守停止）
const {
  handleAutoExecutionFailure,
} = require("../dist/services/novel/director/automation/application/AutoExecutionFailureHandler.js");

// 预算记账辅助（用于播种"预算已耗尽"状态）
const {
  buildDirectorQualityLoopBudgetWindow,
  buildDirectorQualityLoopIssueSignature,
  buildDirectorQualityLoopIssueSignatureFromIssues,
  recordDirectorQualityLoopBudgetAttempt,
} = require("../dist/services/novel/director/runtime/DirectorQualityLoopBudgetLedgerService.js");

// 电路熔断辅助：播种"同章节已累计 N 次 patch 失败信号"（与生产 update 同步）
const {
  recordPatchFailureSignal,
} = require("../dist/services/novel/director/runtime/DirectorCircuitBreakerService.js");

const REPLAN_MESSAGE = `${CONTRACT_REPLAN_WINDOW_MARKER} 章节执行合同职责过载，需整窗重排`;

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
      targetChapterCount: 10,
    },
    runMode: "full_book_autopilot",
    provider: "test-provider",
    model: "test-model",
    temperature: 0.5,
    ...overrides,
  };
}

function withExecutionDetail(order) {
  return {
    id: `chapter-${order}`,
    order,
    title: `第${order}章`,
    generationState: "planned",
    chapterStatus: "pending_generation",
    content: "",
    purpose: `第${order}章目标`,
    exclusiveEvent: `第${order}章独占事件`,
    endingState: `第${order}章结尾状态`,
    nextChapterEntryState: `第${order + 1}章入场状态`,
    conflictLevel: 5,
    revealLevel: 3,
    targetWordCount: 2800,
    mustAvoid: "不要展开无关支线",
    taskSheet: `第${order}章任务单`,
    sceneCards: JSON.stringify({
      targetWordCount: 2800,
      scenes: [
        { key: `c${order}s1`, title: "起势", purpose: "推进", mustAdvance: ["主线"], mustPreserve: ["动机"], entryState: "进入", exitState: "升级", targetWordCount: 900 },
      ],
    }),
  };
}

function buildAutoExecution(overrides = {}) {
  return {
    enabled: true,
    mode: "book",
    autoReview: true,
    autoRepair: true,
    firstChapterId: "chapter-6",
    startOrder: 6,
    endOrder: 10,
    totalChapterCount: 10,
    nextChapterId: "chapter-6",
    nextChapterOrder: 6,
    remainingChapterIds: ["chapter-6", "chapter-7", "chapter-8"],
    remainingChapterOrders: [6, 7, 8],
    remainingChapterCount: 3,
    qualityRepairRisk: {
      noticeCode: "PIPELINE_REPLAN_REQUIRED",
      riskLevel: "replan",
      repairMode: "heavy_repair",
    },
    ...overrides,
  };
}

function buildRange() {
  return { startOrder: 6, endOrder: 10, totalChapterCount: 10, firstChapterId: "chapter-6" };
}

function buildJob() {
  return {
    id: "job-failed",
    status: "failed",
    progress: 0.98,
    error: REPLAN_MESSAGE,
  };
}

function buildDeps() {
  const calls = { replanNovel: [], markTaskFailed: [], bootstrapTask: [], recordEvent: [] };
  const deps = {
    novelContextService: {
      async listChapters() {
        return [6, 7, 8].map((order) => withExecutionDetail(order));
      },
    },
    workflowService: {
      async bootstrapTask() {
        calls.bootstrapTask.push(true);
      },
      async markTaskFailed(taskId, message, patch) {
        calls.markTaskFailed.push({ taskId, message, checkpointType: patch?.checkpointType });
      },
    },
    buildDirectorSeedPayload(_request, _novelId, extra) {
      return extra ?? {};
    },
    automationLedgerEventService: {
      async recordEvent(input) {
        calls.recordEvent.push(input.type);
      },
      async recordRepairTicketCreated() {},
      async recordCircuitBreakerOpened() {},
    },
    async replanNovel(novelId, input) {
      calls.replanNovel.push({ novelId, input });
    },
  };
  return { deps, calls };
}

function baseHandlerInput({ deps, autoExecution, job }) {
  return {
    deps,
    taskId: "task-1",
    novelId: "novel-1",
    request: buildRequest(),
    range: buildRange(),
    autoExecution,
    pipelineJobId: "job-failed",
    job,
    allowLazyChapterPlanning: true,
    progressGuard: {},
    maxConsecutiveNoProgress: 3,
    resolveQualityIssueChapter: async () => null,
  };
}

/**
 * 播种"同章节已累计 N 次 patch 失败信号"到 autoExecution.circuitBreaker，
 * 与生产 buildFailureCircuitBreaker（recordPatchFailureSignal 按章累计）同机制。
 * 若不播种，测试永远看不到熔断与预算阶梯的相互作用（生产侧前几次失败会真实累计）。
 */
function seedPatchFailureSignals(autoExecution, count) {
  let state = autoExecution;
  for (let i = 0; i < count; i += 1) {
    state = {
      ...state,
      circuitBreaker: recordPatchFailureSignal({
        previous: state.circuitBreaker,
        chapterId: "chapter-6",
        chapterOrder: 6,
        message: GENERIC_QUALITY_FAILURE,
      }),
    };
  }
  return state;
}

test("replan_window 失败首次触发自动重排（triggerType=contract_replan_window）并 continue", async () => {
  const { deps, calls } = buildDeps();
  const autoExecution = buildAutoExecution({ qualityDebtSummaries: null });
  const result = await handleAutoExecutionFailure(baseHandlerInput({
    deps,
    autoExecution,
    job: buildJob(),
  }));

  assert.equal(result.kind, "continue");
  // 首次 replan_window：调用 replanNovel，triggerType 应为合同重排分类，而非 audit_failure
  assert.equal(calls.replanNovel.length, 1);
  assert.equal(calls.replanNovel[0].novelId, "novel-1");
  assert.equal(calls.replanNovel[0].input.triggerType, "contract_replan_window");
  assert.equal(calls.replanNovel[0].input.chapterId, "chapter-6");
  // continue 不应 markTaskFailed，也不发误导性事件
  assert.equal(calls.markTaskFailed.length, 0);
  assert.equal(calls.recordEvent.includes("continue_with_risk"), false);
});

test("同签名 replan_window 失败预算耗尽：不再 replan，保守 markTaskFailed 停止，不发 continue_with_risk", async () => {
  const { deps, calls } = buildDeps();
  // 播种 windowReplan 预算已耗尽（windowReplan 限额 = 1），且让 autoExecution.qualityRepairRisk
  // 与 failureMessage 与播种用的 issueSignature 对齐，使 runFullBookAutopilotReplanNotice 命中 defer_and_continue。
  const autoExecution = recordDirectorQualityLoopBudgetAttempt({
    state: buildAutoExecution({ qualityDebtSummaries: null }),
    novelId: "novel-1",
    taskId: "task-1",
    issueSignature: buildDirectorQualityLoopIssueSignature({
      reason: REPLAN_MESSAGE,
      noticeCode: "PIPELINE_REPLAN_REQUIRED",
      riskLevel: "replan",
      repairMode: "heavy_repair",
    }),
    affectedChapterWindow: buildDirectorQualityLoopBudgetWindow({
      autoExecution: buildAutoExecution(),
      chapterId: "chapter-6",
      chapterOrder: 6,
    }),
    action: "window_replan",
    reason: REPLAN_MESSAGE,
    chapterId: "chapter-6",
    chapterOrder: 6,
  }).state;

  const result = await handleAutoExecutionFailure(baseHandlerInput({
    deps,
    autoExecution,
    job: buildJob(),
  }));

  assert.equal(result.kind, "stop");
  // 预算耗尽 → 不再调用 replanNovel
  assert.equal(calls.replanNovel.length, 0);
  // 保守停止：markTaskFailed，checkpointType 为 replan_required
  assert.equal(calls.markTaskFailed.length, 1);
  assert.equal(calls.markTaskFailed[0].checkpointType, "replan_required");
  // 关键：不构建/记录误导性 continue_with_risk，也不重复记账
  assert.equal(calls.recordEvent.includes("continue_with_risk"), false);
  assert.equal(calls.recordEvent.length, 0);
});

// ---- 方案 C（Phase 2）：patch/rewrite 成为可执行动作，重进管线而非 markTaskFailed ----

const GENERIC_QUALITY_FAILURE = "章节执行合同质量未达阈值：正文与任务单存在认知偏差。";

function buildGenericJob() {
  return {
    id: "job-failed",
    status: "failed",
    progress: 0.98,
    error: GENERIC_QUALITY_FAILURE,
    payload: null,
  };
}

test("方案C: 通用质量失败首次预算 patch：重进管线 continue 而非 markTaskFailed", async () => {
  const { deps, calls } = buildDeps();
  const autoExecution = buildAutoExecution({ qualityDebtSummaries: null });

  const result = await handleAutoExecutionFailure(baseHandlerInput({
    deps,
    autoExecution,
    job: buildGenericJob(),
  }));

  // patch 是活动作：返回 continue 让执行环重放该批次，而不是终态停等
  assert.equal(result.kind, "continue");
  assert.equal(calls.markTaskFailed.length, 0);
  // 本轮已记账（patchRepairCount = 1），预算随 continue 状态携带推进
  const ledger = result.autoExecution?.qualityLoopLedger;
  assert.ok(ledger, "continue 后应写入 qualityLoopLedger");
  const patchEntry = ledger.entries.find((entry) => entry.patchRepairCount === 1);
  assert.ok(patchEntry, "应记录一次 patch_repair 动作");
  // 不误发 continue_with_risk（那是 defer 语义，patch 是主动重进）
  assert.equal(calls.recordEvent.includes("continue_with_risk"), false);
});

test("方案C: patch 预算耗尽后决策 auto_rewrite_chapter：仍重进管线并记账 rewrite", async () => {
  const { deps, calls } = buildDeps();
  let autoExecution = buildAutoExecution({ qualityDebtSummaries: null });
  const sig = buildDirectorQualityLoopIssueSignature({
    reason: GENERIC_QUALITY_FAILURE,
    noticeCode: undefined,
    repairMode: undefined,
  });
  const window = buildDirectorQualityLoopBudgetWindow({
    autoExecution,
    chapterId: "chapter-6",
    chapterOrder: 6,
  });
  // 播种两次 patch_repair（patch 预算 = 2 已耗尽），使 resolve → auto_rewrite_chapter
  for (let i = 0; i < 2; i += 1) {
    autoExecution = recordDirectorQualityLoopBudgetAttempt({
      state: autoExecution,
      novelId: "novel-1",
      taskId: "task-1",
      issueSignature: sig,
      affectedChapterWindow: window,
      action: "patch_repair",
      reason: GENERIC_QUALITY_FAILURE,
      chapterId: "chapter-6",
      chapterOrder: 6,
    }).state;
  }
  // 生产同步：前两次 patch 重放各记一次 patch 失败信号 → 熔断 patchFailureCount=2。
  // rewrite 决策失败时到位（第 3 次，熔断 =3 < patchFailureOpenAt=4）→ 熔断未开 → 可 continue。
  autoExecution = seedPatchFailureSignals(autoExecution, 2);

  const result = await handleAutoExecutionFailure(baseHandlerInput({
    deps,
    autoExecution,
    job: buildGenericJob(),
  }));

  assert.equal(result.kind, "continue");
  assert.equal(calls.markTaskFailed.length, 0);
  // 本轮记账应升级到 chapter_rewrite（rewrite 预算 +1）
  const ledger = result.autoExecution?.qualityLoopLedger;
  assert.ok(ledger, "continue 后应写入 qualityLoopLedger");
  const rewriteEntry = ledger.entries.find(
    (entry) => entry.patchRepairCount === 2 && entry.chapterRewriteCount === 1,
  );
  assert.ok(rewriteEntry, "应记录一次 chapter_rewrite 动作（升级到更高 tier）");
});

test("方案C Phase3: 消息文本漂移但信封相同 → 预算仍按结构单调升级（rewrite）", async () => {
  const { deps, calls } = buildDeps();
  let autoExecution = buildAutoExecution({ qualityDebtSummaries: null });

  // 结构化签名：信封只含 recommendedHandling + issueTargets（closed enum），不含自由文本
  const structuredSignature = buildDirectorQualityLoopIssueSignatureFromIssues({
    recommendedHandling: "repair_contract",
    issueTargets: ["task_sheet"],
    noticeCode: null,
    repairMode: "light_repair",
  });
  const window = buildDirectorQualityLoopBudgetWindow({
    autoExecution,
    chapterId: "chapter-6",
    chapterOrder: 6,
  });
  // 播种两次 patch_repair（同结构化签名；两次 reason 文案不同，模拟 LLM 输出波动）
  for (let i = 0; i < 2; i += 1) {
    autoExecution = recordDirectorQualityLoopBudgetAttempt({
      state: autoExecution,
      novelId: "novel-1",
      taskId: "task-1",
      issueSignature: structuredSignature,
      affectedChapterWindow: window,
      action: "patch_repair",
      reason: i === 0 ? "第 1 次质量失败：任务单泄露内部码" : "第 2 次质量失败：任务单遗漏关键义务",
      chapterId: "chapter-6",
      chapterOrder: 6,
    }).state;
  }
  // 生产同步：前两次 patch 重放各记一次 patch 失败信号 → 熔断 patchFailureCount=2（未开）。
  autoExecution = seedPatchFailureSignals(autoExecution, 2);

  // 第三次失败：信封相同，但正文文案与播种时完全不同（LLM 文本漂移 + 注入 qualityFeedback 引导）
  const envelope = buildContractIssueDescriptor({
    status: "repairable",
    canEnterExecution: false,
    issues: [{ id: "task_sheet_codes", severity: "high", target: "task_sheet", summary: "任务单内部码泄露", repairHint: "清理" }],
    summary: "章节执行合同质量未达阈值",
    repairGuidance: ["清理内部码"],
    confidence: 0.8,
  });
  const result = await handleAutoExecutionFailure(baseHandlerInput({
    deps,
    autoExecution,
    job: {
      id: "job-failed",
      status: "failed",
      progress: 0.98,
      error: `${envelope} 这一次是完全不同的失败文案段落，长度与措辞均与之前不同。`,
      payload: JSON.stringify({ repairMode: "light_repair" }),
    },
  }));

  // 信封结构签名 → findEntries 命中播种条目 → patch 耗尽后升级到 rewrite → continue
  assert.equal(result.kind, "continue");
  assert.equal(calls.markTaskFailed.length, 0);
  const ledger = result.autoExecution?.qualityLoopLedger;
  assert.ok(ledger, "continue 后应写入 qualityLoopLedger");
  const rewriteEntry = ledger.entries.find(
    (entry) => entry.patchRepairCount === 2 && entry.chapterRewriteCount === 1,
  );
  assert.ok(rewriteEntry, "消息文本漂移下仍应按稳定结构累计 patch×2 + rewrite×1");
});

// ---- 方案D（P1-4）：瞬态模型/服务故障独立 fallback 预算 ----

const TRANSIENT_MODEL_MESSAGE = "章节执行时上游服务瞬时故障：fetch failed (503 Service Unavailable)，请稍后重试。";

function buildTransientJob() {
  return {
    id: "job-failed",
    status: "failed",
    progress: 0.98,
    error: TRANSIENT_MODEL_MESSAGE,
    payload: null,
  };
}

test("方案D P1-4: 瞬态模型失败（503）预算内 → 独立 fallback 重投 continue，不污染质量预算/不 markTaskFailed", async () => {
  const { deps, calls } = buildDeps();
  const autoExecution = buildAutoExecution({ qualityDebtSummaries: null });

  const result = await handleAutoExecutionFailure(baseHandlerInput({
    deps,
    autoExecution,
    job: buildTransientJob(),
  }));

  // 走 fallback 分支：重进管线 continue，而非终态停等/质量修复记账
  assert.equal(result.kind, "continue");
  assert.equal(calls.markTaskFailed.length, 0);
  // 独立预算自增，且不写入质量预算阶梯（不污染内容修复阶梯）
  assert.equal(result.autoExecution.transientModelFallbackCount, 1);
  assert.equal((result.autoExecution.qualityLoopLedger?.entries ?? []).length, 0);
});

test("方案D P1-4: 瞬态失败预算耗尽后回落 质量预算阶梯（不再误入 fallback 分支）", async () => {
  const { deps, calls } = buildDeps();
  const autoExecution = buildAutoExecution({
    qualityDebtSummaries: null,
    // 预耗尽 fallback 预算（跨 run 已累计到上限）
    transientModelFallbackCount: 3,
  });

  const result = await handleAutoExecutionFailure(baseHandlerInput({
    deps,
    autoExecution,
    job: buildTransientJob(),
  }));

  // 预算耗尽：瞬态分支被跳过，落入既有质量预算路径（首次 patch 仍是活动作 → 重进管线 continue）
  assert.equal(result.kind, "continue");
  // fallback 预算不再自增
  assert.equal(result.autoExecution.transientModelFallbackCount, 3);
  // 本次失败被计入质量系数阶梯（patch_repair），持续故障最终熔断需人工介入
  const patchEntry = result.autoExecution?.qualityLoopLedger?.entries?.find(
    (entry) => entry.patchRepairCount === 1,
  );
  assert.ok(patchEntry, "fallback 预算耗尽后瞬态失败被计入质量预算阶梯");
});

test("方案C Phase3 熔断对齐: 通用失败第 4 次同签名（patch×2 + rewrite×1 后）→ 熔断打开保守停止", async () => {
  const { deps, calls } = buildDeps();
  let autoExecution = buildAutoExecution({ qualityDebtSummaries: null });
  const sig = buildDirectorQualityLoopIssueSignature({
    reason: GENERIC_QUALITY_FAILURE,
    noticeCode: undefined,
    repairMode: undefined,
  });
  const window = buildDirectorQualityLoopBudgetWindow({
    autoExecution,
    chapterId: "chapter-6",
    chapterOrder: 6,
  });
  // 阶梯已爬满：patch×2 + rewrite×1（预算账本），同时熔断已累计 3 次 patch 失败信号。
  for (let i = 0; i < 2; i += 1) {
    autoExecution = recordDirectorQualityLoopBudgetAttempt({
      state: autoExecution,
      novelId: "novel-1",
      taskId: "task-1",
      issueSignature: sig,
      affectedChapterWindow: window,
      action: "patch_repair",
      reason: GENERIC_QUALITY_FAILURE,
      chapterId: "chapter-6",
      chapterOrder: 6,
    }).state;
  }
  autoExecution = recordDirectorQualityLoopBudgetAttempt({
    state: autoExecution,
    novelId: "novel-1",
    taskId: "task-1",
    issueSignature: sig,
    affectedChapterWindow: window,
    action: "chapter_rewrite",
    reason: GENERIC_QUALITY_FAILURE,
    chapterId: "chapter-6",
    chapterOrder: 6,
  }).state;
  autoExecution = seedPatchFailureSignals(autoExecution, 3);

  const result = await handleAutoExecutionFailure(baseHandlerInput({
    deps,
    autoExecution,
    job: buildGenericJob(),
  }));

  // patchFailureOpenAt = patchRepair + chapterRewrite + 1 = 4：第 4 次失败熔断打开 → 保守停止，
  // 不再 continue 无界重放；也不发误导性 continue_with_risk。
  assert.equal(result.kind, "stop");
  assert.equal(calls.markTaskFailed.length, 1);
  assert.equal(calls.recordEvent.includes("continue_with_risk"), false);
});
