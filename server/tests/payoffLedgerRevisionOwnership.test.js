const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const promptRunner = require("../dist/prompting/core/promptRunner.js");
const {
  PayoffLedgerSyncService,
  payoffLedgerSyncService,
} = require("../dist/services/payoff/PayoffLedgerSyncService.js");
const {
  ChapterArtifactBackgroundSyncService,
} = require("../dist/services/novel/runtime/ChapterArtifactBackgroundSyncService.js");
const {
  ChapterProjectionSupersededError,
} = require("../dist/services/novel/runtime/projections/index.js");
const {
  extendStalePendingPayoffWindows,
  syncPayoffLedgerOpenConflicts,
} = require("../dist/services/payoff/sync/index.js");

function makePromptItem() {
  return {
    ledgerKey: "old_revision_payoff",
    title: "旧 revision 伏笔",
    summary: "旧正文生成的全量伏笔结果。",
    scopeType: "book",
    currentStatus: "setup",
    targetStartChapterOrder: 1,
    targetEndChapterOrder: 20,
    firstSeenChapterOrder: 1,
    lastTouchedChapterOrder: 1,
    setupChapterOrder: 1,
    sourceRefs: [],
    evidence: [{ summary: "旧正文证据", chapterOrder: 1 }],
    riskSignals: [],
    statusReason: "旧 revision 输出",
    confidence: 0.9,
  };
}

function makeExistingRow() {
  const now = new Date("2026-07-28T00:00:00.000Z");
  return {
    id: "payoff-1",
    novelId: "novel-1",
    ledgerKey: "existing-payoff",
    title: "已有伏笔",
    summary: "保留已有结果",
    scopeType: "book",
    currentStatus: "setup",
    targetStartChapterOrder: 1,
    targetEndChapterOrder: 20,
    firstSeenChapterOrder: 1,
    lastTouchedChapterOrder: 1,
    lastTouchedChapterId: "chapter-1",
    setupChapterId: "chapter-1",
    payoffChapterId: null,
    lastSnapshotId: null,
    sourceRefsJson: "[]",
    evidenceJson: "[]",
    riskSignalsJson: "[]",
    statusReason: null,
    confidence: 0.8,
    setupChapter: { order: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

test("full payoff reconcile cannot write after its chapter revision is superseded", async () => {
  const originals = {
    transaction: prisma.$transaction,
    chapterFindMany: prisma.chapter.findMany,
    runStructuredPrompt: promptRunner.runStructuredPrompt,
  };
  const service = new PayoffLedgerSyncService();
  const writes = { payoff: 0, conflicts: 0 };
  let currentContentRevision = 7;
  let releasePrompt;
  let signalPromptStarted;
  const promptStarted = new Promise((resolve) => {
    signalPromptStarted = resolve;
  });
  const promptReleased = new Promise((resolve) => {
    releasePrompt = resolve;
  });

  service.loadLedgerRows = async () => [];
  service.buildSyncPromptInput = async () => ({
    chapterOrder: 1,
    latestSnapshotId: null,
    bookContractFields: null,
    activeBookContractRefIds: new Set(),
    promptInput: {
      novelTitle: "并发测试小说",
      activeVolumeSummary: "无",
      latestChapterContext: "第一章",
      majorPayoffsText: "无",
      openPayoffsText: "无",
      chapterPayoffRefsText: "无",
      foreshadowStatesText: "无",
      payoffConflictsText: "无",
      payoffAuditIssuesText: "无",
    },
  });
  prisma.chapter.findMany = async () => [{ id: "chapter-1", order: 1 }];
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => currentContentRevision === 7 ? 1 : 0,
    payoffLedgerItem: {
      update: async () => { writes.payoff += 1; },
      upsert: async () => { writes.payoff += 1; },
      delete: async () => { writes.payoff += 1; },
    },
    openConflict: {
      updateMany: async () => {
        writes.conflicts += 1;
        return { count: 0 };
      },
      create: async () => { writes.conflicts += 1; },
    },
  });
  promptRunner.runStructuredPrompt = async () => {
    signalPromptStarted();
    await promptReleased;
    return { output: { items: [makePromptItem()] } };
  };

  try {
    const sync = service.syncLedger("novel-1", {
      chapterOrder: 1,
      sourceChapterId: "chapter-1",
      projectionOwner: {
        novelId: "novel-1",
        chapterId: "chapter-1",
        expectedContentRevision: 7,
      },
    });
    await promptStarted;
    currentContentRevision = 8;
    releasePrompt();
    await assert.rejects(sync, { name: "ChapterProjectionSupersededError" });
    assert.deepEqual(writes, { payoff: 0, conflicts: 0 });
  } finally {
    prisma.$transaction = originals.transaction;
    prisma.chapter.findMany = originals.chapterFindMany;
    promptRunner.runStructuredPrompt = originals.runStructuredPrompt;
  }
});

test("payoff fallback does not convert supersession into a stale-risk write", async () => {
  const originalTransaction = prisma.$transaction;
  const service = new PayoffLedgerSyncService();
  const existing = makeExistingRow();
  let writes = 0;
  service.loadLedgerRows = async () => [existing];
  service.buildSyncPromptInput = async () => {
    throw new Error("synthetic prompt transport failure");
  };
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 0,
    payoffLedgerItem: {
      update: async () => {
        writes += 1;
      },
    },
  });

  try {
    await assert.rejects(
      service.syncLedger("novel-1", {
        chapterOrder: 1,
        sourceChapterId: "chapter-1",
        projectionOwner: {
          novelId: "novel-1",
          chapterId: "chapter-1",
          expectedContentRevision: 7,
        },
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.equal(writes, 0);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("payoff window and conflict follow-up transactions lock revision first", async () => {
  const originals = {
    transaction: prisma.$transaction,
    payoffFindMany: prisma.payoffLedgerItem.findMany,
  };
  const writes = { payoff: 0, conflicts: 0 };
  prisma.payoffLedgerItem.findMany = async () => [{
    ...makeExistingRow(),
    currentStatus: "pending_payoff",
    targetEndChapterOrder: 3,
  }];
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 0,
    payoffLedgerItem: {
      update: async () => { writes.payoff += 1; },
    },
    openConflict: {
      updateMany: async () => {
        writes.conflicts += 1;
        return { count: 0 };
      },
      create: async () => { writes.conflicts += 1; },
    },
  });
  const projectionOwner = {
    novelId: "novel-1",
    chapterId: "chapter-1",
    expectedContentRevision: 7,
  };

  try {
    await assert.rejects(
      extendStalePendingPayoffWindows({
        novelId: "novel-1",
        chapterOrder: 8,
        projectionOwner,
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    await assert.rejects(
      syncPayoffLedgerOpenConflicts({
        novelId: "novel-1",
        items: [],
        chapterOrder: 8,
        projectionOwner,
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { payoff: 0, conflicts: 0 });
  } finally {
    prisma.$transaction = originals.transaction;
    prisma.payoffLedgerItem.findMany = originals.payoffFindMany;
  }
});

test("background full reconcile claims a checkpoint and degrades supersession locally", async () => {
  const originalChapterFindFirst = prisma.chapter.findFirst;
  const originalSyncLedger = payoffLedgerSyncService.syncLedger;
  const service = new ChapterArtifactBackgroundSyncService();
  const calls = {
    claims: [],
    succeeded: [],
    failed: [],
  };
  prisma.chapter.findFirst = async () => ({
    id: "chapter-1",
    order: 3,
    title: "第三章",
    content: "旧正文",
    contentRevision: 7,
  });
  service.hasCompletedCheckpoint = async () => false;
  service.claimCheckpoint = async (input) => {
    calls.claims.push(input.artifactType);
    return "claimed";
  };
  service.runTrackedActivity = async (_novelId, _chapter, _kind, run) => run();
  service.artifactDeltaService = {
    syncChapterArtifacts: async () => ({
      stateSnapshotId: null,
      characterResourceProposalCount: 0,
      characterDynamicsCount: 0,
      characterKnowledgeStateCount: 0,
      payoffDeltaCount: 0,
      canonicalCommittedCount: 0,
      concreteFactCount: 0,
      staleMarkedCount: 0,
      requiresFullReconcile: true,
      output: {
        syncPlan: { payoffLedger: "full_reconcile" },
        confidence: 0.9,
      },
    }),
  };
  service.markCheckpoint = async (input) => {
    calls.succeeded.push(input.artifactType);
  };
  service.markCheckpointFailed = async (input) => {
    calls.failed.push(input.artifactType);
  };
  service.shouldRunPayoffFullReconcile = async () => true;
  payoffLedgerSyncService.syncLedger = async () => {
    throw new ChapterProjectionSupersededError({
      novelId: "novel-1",
      chapterId: "chapter-1",
      expectedContentRevision: 7,
    });
  };

  try {
    await service.runChapterSyncNow("novel-1", "chapter-1", "旧正文", {
      artifactSyncMode: "adaptive",
    });
    assert.deepEqual(calls, {
      claims: ["artifact_delta", "payoff_ledger_full_reconcile"],
      succeeded: ["artifact_delta"],
      failed: ["payoff_ledger_full_reconcile"],
    });
  } finally {
    prisma.chapter.findFirst = originalChapterFindFirst;
    payoffLedgerSyncService.syncLedger = originalSyncLedger;
  }
});
