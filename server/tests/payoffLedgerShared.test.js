const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyGraceExtension,
  buildPayoffLedgerResponse,
  buildSyntheticPayoffIssues,
  classifyPayoffLedgerItems,
  isAuditArtifactLedgerKey,
  normalizePayoffLedgerIdentity,
  resolvePayoffLedgerSyncLedgerKey,
  sanitizePayoffLedgerSyncItem,
} = require("../dist/services/payoff/payoffLedgerShared.js");

function createLedgerItem(overrides = {}) {
  return {
    id: overrides.id ?? `ledger-${Math.random().toString(16).slice(2)}`,
    novelId: overrides.novelId ?? "novel-1",
    ledgerKey: overrides.ledgerKey ?? "ledger-key",
    title: overrides.title ?? "女二情报钥匙",
    summary: overrides.summary ?? "女二手里的情报会成为第一次反压的钥匙。",
    scopeType: overrides.scopeType ?? "volume",
    currentStatus: overrides.currentStatus ?? "pending_payoff",
    targetStartChapterOrder: overrides.targetStartChapterOrder ?? 5,
    targetEndChapterOrder: overrides.targetEndChapterOrder ?? 6,
    firstSeenChapterOrder: overrides.firstSeenChapterOrder ?? 3,
    lastTouchedChapterOrder: overrides.lastTouchedChapterOrder ?? 4,
    lastTouchedChapterId: overrides.lastTouchedChapterId ?? "chapter-4",
    setupChapterId: overrides.setupChapterId ?? "chapter-3",
    payoffChapterId: overrides.payoffChapterId ?? null,
    lastSnapshotId: overrides.lastSnapshotId ?? "snapshot-4",
    sourceRefs: overrides.sourceRefs ?? [{
      kind: "volume_open_payoff",
      refId: "volume-1",
      refLabel: "第一卷开放伏笔",
      chapterId: null,
      chapterOrder: 4,
      volumeId: "volume-1",
      volumeSortOrder: 1,
    }],
    evidence: overrides.evidence ?? [{
      summary: "第四章已经明确提到女二掌握关键情报。",
      chapterId: "chapter-4",
      chapterOrder: 4,
    }],
    riskSignals: overrides.riskSignals ?? [],
    statusReason: overrides.statusReason ?? "需要在第5-6章把情报转化为反压动作。",
    confidence: overrides.confidence ?? 0.91,
    createdAt: overrides.createdAt ?? "2026-04-05T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-05T10:00:00.000Z",
  };
}

test("classifyPayoffLedgerItems separates pending urgent overdue and paid-off items", () => {
  const items = [
    createLedgerItem({
      ledgerKey: "pending",
      title: "女二情报钥匙",
      currentStatus: "pending_payoff",
      targetStartChapterOrder: 5,
      targetEndChapterOrder: 6,
    }),
    createLedgerItem({
      ledgerKey: "setup",
      title: "黑市账户异常",
      currentStatus: "setup",
      targetStartChapterOrder: 6,
      targetEndChapterOrder: 6,
    }),
    createLedgerItem({
      ledgerKey: "overdue",
      title: "旧线索回收",
      currentStatus: "overdue",
      targetStartChapterOrder: 3,
      targetEndChapterOrder: 4,
    }),
    createLedgerItem({
      ledgerKey: "paid",
      title: "第一次反压试探",
      currentStatus: "paid_off",
      targetStartChapterOrder: 4,
      targetEndChapterOrder: 4,
      payoffChapterId: "chapter-4",
      lastTouchedChapterOrder: 4,
    }),
  ];

  const classified = classifyPayoffLedgerItems(items, 5);

  assert.deepEqual(classified.pendingItems.map((item) => item.ledgerKey), ["pending", "setup"]);
  assert.deepEqual(classified.urgentItems.map((item) => item.ledgerKey), ["pending", "setup"]);
  assert.deepEqual(classified.overdueItems.map((item) => item.ledgerKey), ["overdue"]);
  assert.deepEqual(classified.paidOffItems.map((item) => item.ledgerKey), ["paid"]);
});

test("buildSyntheticPayoffIssues surfaces overdue missing progress and payoff risk signals", () => {
  const items = [
    createLedgerItem({
      ledgerKey: "overdue",
      title: "黑市账户异常",
      currentStatus: "overdue",
      targetStartChapterOrder: 3,
      targetEndChapterOrder: 4,
      statusReason: "目标窗口已经过去，但主角还没真正查到账本问题。",
    }),
    createLedgerItem({
      ledgerKey: "missing-progress",
      title: "女二情报钥匙",
      currentStatus: "pending_payoff",
      targetStartChapterOrder: 5,
      targetEndChapterOrder: 5,
    }),
    createLedgerItem({
      ledgerKey: "paid-without-setup",
      title: "仓促兑现",
      currentStatus: "paid_off",
      riskSignals: [{
        code: "payoff_paid_without_setup",
        severity: "critical",
        summary: "没有铺垫就直接兑现了关键收益。",
      }],
    }),
    createLedgerItem({
      ledgerKey: "regressed",
      title: "旧线索回退",
      currentStatus: "hinted",
      riskSignals: [{
        code: "payoff_regressed",
        severity: "high",
        summary: "已兑现线索被错误重置为待观察状态。",
      }],
    }),
  ];

  const issues = buildSyntheticPayoffIssues(items, 5);
  const byKey = new Map(issues.map((issue) => [`${issue.ledgerKey}:${issue.code}`, issue]));

  assert.match(byKey.get("overdue:payoff_overdue").description, /超过目标窗口/);
  assert.match(byKey.get("missing-progress:payoff_missing_progress").description, /进入应触碰窗口/);
  assert.match(byKey.get("paid-without-setup:payoff_paid_without_setup").description, /专项风险/);
  assert.equal(byKey.get("paid-without-setup:payoff_paid_without_setup").severity, "critical");
  assert.match(byKey.get("regressed:payoff_regressed").fixSuggestion, /新的账本项/);
});

test("buildPayoffLedgerResponse orders items by risk and computes summary counts", () => {
  const response = buildPayoffLedgerResponse([
    createLedgerItem({
      ledgerKey: "paid",
      title: "第一次反压试探",
      currentStatus: "paid_off",
      updatedAt: "2026-04-05T10:00:03.000Z",
    }),
    createLedgerItem({
      ledgerKey: "pending",
      title: "女二情报钥匙",
      currentStatus: "pending_payoff",
      updatedAt: "2026-04-05T10:00:02.000Z",
    }),
    createLedgerItem({
      ledgerKey: "overdue",
      title: "黑市账户异常",
      currentStatus: "overdue",
      updatedAt: "2026-04-05T10:00:04.000Z",
    }),
  ], 5);

  assert.deepEqual(response.items.map((item) => item.ledgerKey), ["overdue", "pending", "paid"]);
  assert.equal(response.summary.pendingCount, 1);
  assert.equal(response.summary.overdueCount, 1);
  assert.equal(response.summary.paidOffCount, 1);
  assert.equal(response.updatedAt, "2026-04-05T10:00:04.000Z");
});

test("normalizePayoffLedgerIdentity removes spacing and common punctuation", () => {
  assert.equal(
    normalizePayoffLedgerIdentity("第一次小成功：复习完一门课，并测试通过！"),
    normalizePayoffLedgerIdentity("第一次小成功 复习完一门课并测试通过"),
  );
});

test("resolvePayoffLedgerSyncLedgerKey reuses unfinished ledger item with matching title", () => {
  const existingRows = [
    createLedgerItem({
      ledgerKey: "first_success_volume",
      title: "第一次小成功：复习完一门课并测试通过",
      scopeType: "volume",
      currentStatus: "pending_payoff",
      targetEndChapterOrder: 50,
      lastTouchedChapterOrder: 50,
      updatedAt: "2026-04-05T10:00:03.000Z",
    }),
    createLedgerItem({
      ledgerKey: "first_small_success",
      title: "第一次小成功：复习完一门课并测试通过",
      scopeType: "book",
      currentStatus: "pending_payoff",
      targetEndChapterOrder: 46,
      lastTouchedChapterOrder: 45,
      updatedAt: "2026-04-05T10:00:02.000Z",
    }),
  ];

  const resolvedKey = resolvePayoffLedgerSyncLedgerKey({
    ledgerKey: "review_first_success",
    title: "第一次小成功 复习完一门课并测试通过",
    scopeType: "book",
    currentStatus: "overdue",
    targetStartChapterOrder: null,
    targetEndChapterOrder: null,
    riskSignals: [],
  }, existingRows);

  assert.equal(resolvedKey, "first_small_success");
});

test("resolvePayoffLedgerSyncLedgerKey does not reuse paid-off or failed title matches", () => {
  const existingRows = [
    createLedgerItem({
      ledgerKey: "paid_first_success",
      title: "第一次小成功：复习完一门课并测试通过",
      currentStatus: "paid_off",
      updatedAt: "2026-04-05T10:00:03.000Z",
    }),
    createLedgerItem({
      ledgerKey: "failed_first_success",
      title: "第一次小成功：复习完一门课并测试通过",
      currentStatus: "failed",
      updatedAt: "2026-04-05T10:00:02.000Z",
    }),
  ];

  const resolvedKey = resolvePayoffLedgerSyncLedgerKey({
    ledgerKey: "review_first_success",
    title: "第一次小成功：复习完一门课并测试通过",
    scopeType: "book",
    currentStatus: "pending_payoff",
    targetStartChapterOrder: null,
    targetEndChapterOrder: null,
    riskSignals: [],
  }, existingRows);

  assert.equal(resolvedKey, "review_first_success");
});

test("sanitizePayoffLedgerSyncItem downgrades overdue without explicit payoff window", () => {
  const item = sanitizePayoffLedgerSyncItem({
    ledgerKey: "review_first_success",
    title: "第一次小成功：复习完一门课并测试通过",
    scopeType: "book",
    currentStatus: "overdue",
    targetStartChapterOrder: null,
    targetEndChapterOrder: null,
    payoffChapterId: null,
    payoffChapterOrder: null,
    riskSignals: [],
    statusReason: "已过合理兑现窗口，但尚未完成测试。",
  });

  assert.equal(item.currentStatus, "pending_payoff");
  assert.equal(item.riskSignals.length, 1);
  assert.equal(item.riskSignals[0].code, "payoff_missing_progress");
});

test("applyGraceExtension extends window when pending payoff targetEnd is past current chapter", () => {
  const item = applyGraceExtension({
    ledgerKey: "tide_salamander_recruit",
    title: "唤潮蝾螈的招募",
    scopeType: "volume",
    currentStatus: "pending_payoff",
    targetStartChapterOrder: 5,
    targetEndChapterOrder: 15,
    payoffChapterId: null,
    payoffChapterOrder: null,
    riskSignals: [],
    statusReason: null,
  }, 22);

  assert.equal(item.currentStatus, "pending_payoff");
  assert.equal(item.targetStartChapterOrder, 15);
  assert.equal(item.targetEndChapterOrder, 25);
  assert.equal(item.riskSignals.length, 1);
  assert.equal(item.riskSignals[0].code, "payoff_window_extended");
  assert.match(item.riskSignals[0].summary, /顺延至第15-25章/);
});

test("applyGraceExtension leaves item unchanged when targetEnd not yet past current chapter", () => {
  const item = applyGraceExtension({
    ledgerKey: "k1",
    title: "未到期伏笔",
    scopeType: "volume",
    currentStatus: "pending_payoff",
    targetStartChapterOrder: 24,
    targetEndChapterOrder: 28,
    payoffChapterId: null,
    payoffChapterOrder: null,
    riskSignals: [],
    statusReason: null,
  }, 22);

  assert.equal(item.targetEndChapterOrder, 28);
  assert.equal(item.riskSignals.length, 0);
});

test("applyGraceExtension skips non-pending_payoff statuses", () => {
  for (const status of ["setup", "hinted", "paid_off", "failed", "overdue"]) {
    const item = applyGraceExtension({
      ledgerKey: "k1",
      title: "t",
      scopeType: "volume",
      currentStatus: status,
      targetStartChapterOrder: 5,
      targetEndChapterOrder: 6,
      payoffChapterId: null,
      payoffChapterOrder: null,
      riskSignals: [],
      statusReason: null,
    }, 22);
    assert.equal(item.targetEndChapterOrder, 6, `${status} should not be extended`);
    assert.equal(item.riskSignals.length, 0, `${status} should not gain risk signal`);
  }
});

test("applyGraceExtension stops extending after 3 prior extensions", () => {
  const existing = Array.from({ length: 3 }, (_, i) => ({
    code: "payoff_window_extended",
    severity: "medium",
    summary: `目标窗口已过未兑现，自动顺延至第${5 + i * 10}-${6 + i * 10}章。`,
  }));
  const item = applyGraceExtension({
    ledgerKey: "k1",
    title: "t",
    scopeType: "volume",
    currentStatus: "pending_payoff",
    targetStartChapterOrder: 5,
    targetEndChapterOrder: 6,
    payoffChapterId: null,
    payoffChapterOrder: null,
    riskSignals: existing,
    statusReason: null,
  }, 22);

  assert.equal(item.targetEndChapterOrder, 6, "should not extend beyond max");
  assert.equal(item.riskSignals.length, 3, "should not add new signal");
});

test("applyGraceExtension uses targetEnd as nextStart when targetStartChapterOrder is null", () => {
  const item = applyGraceExtension({
    ledgerKey: "k1",
    title: "无起始窗口伏笔",
    scopeType: "volume",
    currentStatus: "pending_payoff",
    targetStartChapterOrder: null,
    targetEndChapterOrder: 15,
    payoffChapterId: null,
    payoffChapterOrder: null,
    riskSignals: [],
    statusReason: null,
  }, 22);

  assert.equal(item.currentStatus, "pending_payoff");
  assert.equal(item.targetStartChapterOrder, 15, "nextStart should fall back to targetEnd");
  assert.equal(item.targetEndChapterOrder, 25, "nextEnd should be targetEnd + STEP");
  assert.equal(item.riskSignals.length, 1);
  assert.equal(item.riskSignals[0].code, "payoff_window_extended");
});

// --- isAuditArtifactLedgerKey ---

test("isAuditArtifactLedgerKey identifies chapterN_missing_progress pattern", () => {
  // 章号前缀 + 审计后缀（旧命名形态）
  assert.equal(isAuditArtifactLedgerKey("chapter36_missing_progress"), true);
  assert.equal(isAuditArtifactLedgerKey("chapter23_24_missing_progress"), true);
  assert.equal(isAuditArtifactLedgerKey("ch9_missing_progress"), true);
  assert.equal(isAuditArtifactLedgerKey("ch12_13_overdue"), true);
  // 审计语义前缀 + 章号后缀（新命名形态，LLM 换写法）
  assert.equal(isAuditArtifactLedgerKey("missing_obligations_ch48"), true);
  assert.equal(isAuditArtifactLedgerKey("payoff_touch_missing_ch48"), true);
  assert.equal(isAuditArtifactLedgerKey("not_touched_ch50"), true);
  // 有章号作用域但无审计 token → 真实伏笔
  assert.equal(isAuditArtifactLedgerKey("ch9_foreshadow_01"), false);
  assert.equal(isAuditArtifactLedgerKey("ch12_goal_change"), false);
  // 有审计 token 但无章号作用域 → 按故事内容命名，不误删
  assert.equal(isAuditArtifactLedgerKey("slate_map_clue_missing_progress"), false);
  assert.equal(isAuditArtifactLedgerKey("flametail_golden_aftermath"), false);
  assert.equal(isAuditArtifactLedgerKey("northwest_anomaly_base"), false);
  assert.equal(isAuditArtifactLedgerKey("battle_field_identity_first"), false);
  // `ch` 必须是独立段，不能是单词的一部分（mecha_unit_5 含 "ch" 子串但不是章号）
  assert.equal(isAuditArtifactLedgerKey("mecha_unit_5_overdue"), false);
  // 空值
  assert.equal(isAuditArtifactLedgerKey(null), false);
  assert.equal(isAuditArtifactLedgerKey(""), false);
});

// --- sanitizePayoffLedgerSyncItem: pseudo ledger key interception ---

test("sanitizePayoffLedgerSyncItem demotes overdue audit-artifact keys to pending_payoff", () => {
  const item = sanitizePayoffLedgerSyncItem({
    ledgerKey: "chapter36_missing_progress",
    title: "第36章矿洞避雨伏笔推进缺失",
    scopeType: "chapter",
    currentStatus: "overdue",
    targetStartChapterOrder: 36,
    targetEndChapterOrder: 36,
    payoffChapterId: null,
    payoffChapterOrder: null,
    riskSignals: [{
      code: "payoff_missing_progress",
      severity: "high",
      summary: "第36章明确标记推进缺失，已过目标窗口仍未兑现。",
    }],
    statusReason: "目标窗口已过，相关伏笔未兑现，标记为overdue。",
  });

  assert.equal(item.currentStatus, "pending_payoff");
  // 自指的 payoff_missing_progress 被过滤掉，只剩降级信号
  const codes = item.riskSignals.map((s) => s.code);
  assert.ok(!codes.includes("payoff_missing_progress"), "self-referencing signal should be removed");
  assert.ok(codes.includes("pseudo_ledger_demoted"), "demoted signal should be added");
});

test("sanitizePayoffLedgerSyncItem does not demote overdue with real ledger keys", () => {
  const item = sanitizePayoffLedgerSyncItem({
    ledgerKey: "windvillage_intel",
    title: "风来村情报",
    scopeType: "volume",
    currentStatus: "overdue",
    targetStartChapterOrder: 10,
    targetEndChapterOrder: 12,
    payoffChapterId: null,
    payoffChapterOrder: null,
    riskSignals: [],
    statusReason: "逾期未兑现",
  });

  // 有窗口的正常 overdue 不被拦截
  assert.equal(item.currentStatus, "overdue");
  assert.equal(item.riskSignals.length, 0);
});

// --- buildSyntheticPayoffIssues: no feedback loop on pseudo items ---

test("buildSyntheticPayoffIssues skips audit-artifact ledger items to break feedback loop", () => {
  const items = [
    createLedgerItem({
      ledgerKey: "chapter36_missing_progress",
      title: "第36章矿洞避雨伏笔推进缺失",
      currentStatus: "pending_payoff",
      riskSignals: [{
        code: "payoff_missing_progress",
        severity: "high",
        summary: "已过目标窗口仍未兑现。",
      }],
    }),
  ];

  const issues = buildSyntheticPayoffIssues(items, 40);
  // 伪项不再二次产出审计问题
  assert.equal(issues.length, 0, "pseudo ledger items should not emit synthetic issues");
});
