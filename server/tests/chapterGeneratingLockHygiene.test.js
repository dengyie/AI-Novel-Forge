const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  reclaimStaleChapterGeneratingLocks,
  reclaimStaleChapterGeneratingLocksThrottled,
  resetChapterLockReclaimThrottleForTests,
  CHAPTER_GENERATING_STALE_MS,
} = require("../dist/services/novel/runtime/ChapterGeneratingLockHygiene.js");

// 生产 P1 回归：writer 超时/崩溃把章节留在 chapterStatus=generating + 僵尸 running run，
// 锁无自愈，源世界 ch20 曾被 4 次手动 SQL 回收。扫描器必须自动 reset；
// 但绝不能打断一次真在跑的写作（窗口内有活跃 run 的章节必须跳过）。
// 与 artifactCheckpointHygiene.test.js 同约定：stub prisma 方法，不碰真实库。

function stubPrisma({ stuckChapters = [], runningRuns = [], onCancelRuns, onResetChapter }) {
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    agentRunFindMany: prisma.agentRun.findMany,
    agentRunUpdateMany: prisma.agentRun.updateMany,
    chapterUpdateMany: prisma.chapter.updateMany,
  };
  const cancelledRunIds = [];
  const resetChapterIds = [];

  prisma.chapter.findMany = async (args) => {
    assert.equal(args.where.chapterStatus, "generating");
    assert.ok(args.where.updatedAt.lt instanceof Date);
    return stuckChapters;
  };
  prisma.agentRun.findMany = async (args) => {
    assert.equal(args.where.status, "running");
    return runningRuns;
  };
  prisma.agentRun.updateMany = async (args) => {
    assert.equal(args.where.status, "running", "cancel must be conditional on still-running");
    cancelledRunIds.push(...args.where.id.in);
    assert.equal(args.data.status, "cancelled");
    assert.match(args.data.error, /stale generating lock/);
    assert.ok(args.data.finishedAt instanceof Date);
    if (onCancelRuns) onCancelRuns(args);
    return { count: args.where.id.in.length };
  };
  prisma.chapter.updateMany = async (args) => {
    assert.equal(args.where.chapterStatus, "generating", "reset must be conditional on still-generating");
    resetChapterIds.push(args.where.id);
    assert.equal(args.data.chapterStatus, "needs_repair");
    if (onResetChapter) onResetChapter(args);
    return { count: 1 };
  };

  return {
    cancelledRunIds,
    resetChapterIds,
    restore() {
      prisma.chapter.findMany = originals.chapterFindMany;
      prisma.agentRun.findMany = originals.agentRunFindMany;
      prisma.agentRun.updateMany = originals.agentRunUpdateMany;
      prisma.chapter.updateMany = originals.chapterUpdateMany;
    },
  };
}

test("stale generating chapter with zombie running run: chapter reset to needs_repair, run cancelled", async () => {
  const longAgo = new Date(Date.now() - CHAPTER_GENERATING_STALE_MS - 5 * 60_000);
  const stub = stubPrisma({
    stuckChapters: [{ id: "c1", novelId: "n1", order: 20, updatedAt: longAgo }],
    runningRuns: [{ id: "r1", chapterId: "c1", startedAt: longAgo, updatedAt: longAgo }],
  });
  try {
    const result = await reclaimStaleChapterGeneratingLocks();
    assert.equal(result.chaptersReset, 1);
    assert.equal(result.runsCancelled, 1);
    assert.equal(result.skippedActiveChapters, 0);
    assert.deepEqual(stub.cancelledRunIds, ["r1"]);
    assert.deepEqual(stub.resetChapterIds, ["c1"]);
  } finally {
    stub.restore();
  }
});

test("chapter with recently-active running run is NOT touched (in-flight write protection)", async () => {
  const staleChapter = new Date(Date.now() - CHAPTER_GENERATING_STALE_MS - 60_000);
  const recentRun = new Date(Date.now() - 30_000);
  const stub = stubPrisma({
    stuckChapters: [{ id: "c1", novelId: "n1", order: 20, updatedAt: staleChapter }],
    // 章节 updatedAt 陈旧（写流长时间不落库），但 run 30 秒前仍活跃 → 真在跑。
    runningRuns: [{ id: "r1", chapterId: "c1", startedAt: staleChapter, updatedAt: recentRun }],
  });
  try {
    const result = await reclaimStaleChapterGeneratingLocks();
    assert.equal(result.chaptersReset, 0, "active in-flight chapter must stay locked");
    assert.equal(result.runsCancelled, 0, "active run must not be cancelled");
    assert.equal(result.skippedActiveChapters, 1);
    assert.deepEqual(stub.cancelledRunIds, []);
    assert.deepEqual(stub.resetChapterIds, []);
  } finally {
    stub.restore();
  }
});

test("no stale generating chapters: no writes at all", async () => {
  let cancelCalled = false;
  let resetCalled = false;
  const stub = stubPrisma({
    stuckChapters: [],
    runningRuns: [],
    onCancelRuns: () => { cancelCalled = true; },
    onResetChapter: () => { resetCalled = true; },
  });
  try {
    const result = await reclaimStaleChapterGeneratingLocks();
    assert.deepEqual(result, { chaptersReset: 0, runsCancelled: 0, skippedActiveChapters: 0 });
    assert.equal(cancelCalled, false);
    assert.equal(resetCalled, false);
  } finally {
    stub.restore();
  }
});

test("throttled variant respects throttle window", async () => {
  resetChapterLockReclaimThrottleForTests();
  let findCalls = 0;
  const stub = stubPrisma({ stuckChapters: [], runningRuns: [] });
  const originalFind = prisma.chapter.findMany;
  prisma.chapter.findMany = async (...args) => { findCalls += 1; return originalFind(...args); };
  try {
    await reclaimStaleChapterGeneratingLocksThrottled({ throttleMs: 60_000 });
    await reclaimStaleChapterGeneratingLocksThrottled({ throttleMs: 60_000 });
    assert.equal(findCalls, 1, "second call inside throttle window must not hit DB");
  } finally {
    stub.restore();
    resetChapterLockReclaimThrottleForTests();
  }
});
