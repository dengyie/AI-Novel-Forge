const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");
const {
  ChapterProjectionSupersededError,
} = require("../dist/services/novel/runtime/projections/index.js");

/**
 * scheduleChapterSync 必须 .catch fire-and-forget rejection：
 * void promise 在 Node 会变成 unhandledRejection 杀进程。
 * runChapterSyncNow 仍 rethrow 给 await 调用方。
 */
test("scheduleChapterSync swallows runChapterSyncNow rejection", async () => {
  const mod = require("../dist/services/novel/runtime/ChapterArtifactBackgroundSyncService.js");
  const service = mod.chapterArtifactBackgroundSyncService;
  assert.ok(service, "service export");

  const original = service.runChapterSyncNow.bind(service);
  let called = false;
  service.runChapterSyncNow = async () => {
    called = true;
    throw new Error("synthetic transport_error for schedule catch test");
  };

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };

  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    service.scheduleChapterSync("n1", "c1", "body text for hash");
    // allow microtask / promise chain to settle
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, true, "runChapterSyncNow should be invoked");
    assert.equal(unhandled, null, "must not emit unhandledRejection");
    assert.ok(
      warnings.some((w) => w.includes("scheduleChapterSync swallowed")),
      `expected swallow warn, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    console.warn = origWarn;
    service.runChapterSyncNow = original;
  }
});

test("identical content still reaches the revision-owned database checkpoint", async () => {
  const {
    ChapterArtifactBackgroundSyncService,
  } = require("../dist/services/novel/runtime/ChapterArtifactBackgroundSyncService.js");
  const service = new ChapterArtifactBackgroundSyncService();
  let runs = 0;
  service.runChapterSync = async () => {
    runs += 1;
  };

  await service.runChapterSyncNow("novel-1", "chapter-1", "相同正文", { artifactSyncMode: "adaptive" });
  await service.runChapterSyncNow("novel-1", "chapter-1", "相同正文", { artifactSyncMode: "adaptive" });

  assert.equal(runs, 2);
});

test("background artifact supersession is recorded locally and does not escape", async () => {
  const {
    ChapterArtifactBackgroundSyncService,
  } = require("../dist/services/novel/runtime/ChapterArtifactBackgroundSyncService.js");
  const originalChapterFindFirst = prisma.chapter.findFirst;
  const service = new ChapterArtifactBackgroundSyncService();
  const calls = { failed: 0, succeeded: 0, reconcile: 0 };
  prisma.chapter.findFirst = async () => ({
    id: "chapter-1",
    order: 1,
    title: "第一章",
    content: "旧正文",
    contentRevision: 7,
  });
  service.hasCompletedCheckpoint = async () => false;
  service.claimCheckpoint = async () => "claimed";
  service.runTrackedActivity = async (_novelId, _context, _kind, run) => run();
  service.artifactDeltaService = {
    syncChapterArtifacts: async () => {
      throw new ChapterProjectionSupersededError({
        novelId: "novel-1",
        chapterId: "chapter-1",
        expectedContentRevision: 7,
      });
    },
  };
  service.markCheckpointFailed = async () => {
    calls.failed += 1;
  };
  service.markCheckpoint = async () => {
    calls.succeeded += 1;
  };
  service.shouldRunPayoffFullReconcile = async () => {
    calls.reconcile += 1;
    return false;
  };

  try {
    await service.runChapterSyncNow("novel-1", "chapter-1", "旧正文");
    assert.deepEqual(calls, { failed: 1, succeeded: 0, reconcile: 0 });
  } finally {
    prisma.chapter.findFirst = originalChapterFindFirst;
  }
});
