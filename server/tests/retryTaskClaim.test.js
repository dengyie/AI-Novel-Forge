const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { NovelWorkflowApplicationService } = require("../dist/services/novel/workflow/NovelWorkflowApplicationService.js");

// retryTask 认领回归（P1 修复）：
// - 认领是唯一 attemptCount 自增点，条件 updateMany + attemptCount 守卫。
// - 并发/重复调用幂等：守卫不命中（count=0）→ 返回 null，不再自增、不发通知。
// - 通知走认领后的 fresh 行，不是陈旧 before。
// 与 taskRetentionAutopilot 同约定：stub 共享 prisma 单例，串行（concurrency: false）。

function makeStoreStub(existing) {
  const notifications = [];
  return {
    notifications,
    getTaskByIdWithoutHealing: async () => existing,
    notifyAutoDirectorTaskTransition: async (input) => {
      notifications.push(input);
    },
  };
}

function makeExisting(overrides = {}) {
  return {
    id: "wf-1",
    novelId: "n1",
    lane: "auto_director",
    status: "failed",
    checkpointType: null,
    pendingManualRecovery: false,
    attemptCount: 1,
    maxAttempts: 3,
    cancelRequestedAt: null,
    updatedAt: new Date("2026-07-30T00:00:00.000Z"),
    ...overrides,
  };
}

test("retryTask claims exactly once: conditional updateMany increments attemptCount by 1", { concurrency: false }, async () => {
  const existing = makeExisting();
  const store = makeStoreStub(existing);
  const service = new NovelWorkflowApplicationService(store);
  const originals = {
    updateMany: prisma.novelWorkflowTask.updateMany,
    findUnique: prisma.novelWorkflowTask.findUnique,
  };
  const claimArgs = [];
  prisma.novelWorkflowTask.updateMany = async (args) => {
    claimArgs.push(args);
    return { count: 1 };
  };
  const nextRow = { ...existing, status: "queued", attemptCount: 2, novel: { title: "书" } };
  prisma.novelWorkflowTask.findUnique = async () => nextRow;

  try {
    const result = await service.retryTask("wf-1");
    assert.equal(claimArgs.length, 1, "single conditional claim");
    // 防竞态 + 幂等守卫（822b001 起为精确状态 + updatedAt CAS，非 in 宽匹配）
    assert.equal(claimArgs[0].where.status, "failed", "status guard pins the read value");
    assert.equal(claimArgs[0].where.pendingManualRecovery, false);
    assert.equal(claimArgs[0].where.cancelRequestedAt, null);
    assert.equal(claimArgs[0].where.updatedAt, existing.updatedAt, "updatedAt CAS guard pins the read value");
    assert.equal(claimArgs[0].where.attemptCount, 1, "attempt guard pins the read value");
    assert.equal(claimArgs[0].data.attemptCount, 2, "increments exactly once");
    // 通知用 fresh 行
    assert.equal(store.notifications.length, 1);
    assert.equal(store.notifications[0].after, nextRow);
    assert.equal(result, nextRow);
  } finally {
    prisma.novelWorkflowTask.updateMany = originals.updateMany;
    prisma.novelWorkflowTask.findUnique = originals.findUnique;
  }
});

test("retryTask is idempotent on concurrent/duplicate claim: count=0 returns null, no increment, no notify", { concurrency: false }, async () => {
  const existing = makeExisting();
  const store = makeStoreStub(existing);
  const service = new NovelWorkflowApplicationService(store);
  const originals = {
    updateMany: prisma.novelWorkflowTask.updateMany,
    findUnique: prisma.novelWorkflowTask.findUnique,
  };
  // 并发场景：另一个重试已把 attemptCount 推到 2，守卫（attemptCount:1）不命中。
  prisma.novelWorkflowTask.updateMany = async () => ({ count: 0 });
  let findUniqueCalled = false;
  prisma.novelWorkflowTask.findUnique = async () => { findUniqueCalled = true; return null; };

  try {
    const result = await service.retryTask("wf-1");
    assert.equal(result, null, "lost claim returns null so caller skips continue");
    assert.equal(findUniqueCalled, false, "no re-read when claim lost");
    assert.equal(store.notifications.length, 0, "no notification on lost claim");
  } finally {
    prisma.novelWorkflowTask.updateMany = originals.updateMany;
    prisma.novelWorkflowTask.findUnique = originals.findUnique;
  }
});

test("retryTask throws 404 when task missing", { concurrency: false }, async () => {
  const store = makeStoreStub(null);
  const service = new NovelWorkflowApplicationService(store);
  await assert.rejects(() => service.retryTask("missing"), (error) => {
    assert.equal(error.statusCode ?? error.status, 404);
    return true;
  });
});
