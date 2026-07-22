const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  reclaimStaleRunningArtifactCheckpoints,
  reclaimStaleRunningArtifactCheckpointsThrottled,
  resetArtifactCheckpointReclaimThrottleForTests,
  ARTIFACT_CHECKPOINT_RUNNING_STALE_MS,
} = require("../dist/services/novel/runtime/ChapterArtifactSyncCheckpointHygiene.js");

test("reclaimStaleRunningArtifactCheckpoints marks only stale running rows failed", async () => {
  const originalFindMany = prisma.chapterArtifactSyncCheckpoint.findMany;
  const originalUpdateMany = prisma.chapterArtifactSyncCheckpoint.updateMany;
  let updateArgs = null;

  prisma.chapterArtifactSyncCheckpoint.findMany = async (args) => {
    assert.equal(args.where.status, "running");
    assert.ok(args.where.updatedAt.lt instanceof Date);
    assert.equal(args.take, 10);
    return [
      { id: "cp-1", artifactType: "previous_chapter_guard", novelId: "n1", chapterId: "c1" },
      { id: "cp-2", artifactType: "timeline_finalization", novelId: "n1", chapterId: "c2" },
    ];
  };
  prisma.chapterArtifactSyncCheckpoint.updateMany = async (args) => {
    updateArgs = args;
    return { count: 2 };
  };

  try {
    const count = await reclaimStaleRunningArtifactCheckpoints({ limit: 10 });
    assert.equal(count, 2);
    assert.deepEqual(updateArgs.where.id, { in: ["cp-1", "cp-2"] });
    assert.equal(updateArgs.where.status, "running");
    assert.equal(updateArgs.data.status, "failed");
    const meta = JSON.parse(updateArgs.data.metadataJson);
    assert.equal(meta.reason, "stale_running_reclaimed");
    assert.equal(meta.staleMs, ARTIFACT_CHECKPOINT_RUNNING_STALE_MS);
  } finally {
    prisma.chapterArtifactSyncCheckpoint.findMany = originalFindMany;
    prisma.chapterArtifactSyncCheckpoint.updateMany = originalUpdateMany;
  }
});

test("reclaimStaleRunningArtifactCheckpoints returns 0 when none stale", async () => {
  const originalFindMany = prisma.chapterArtifactSyncCheckpoint.findMany;
  const originalUpdateMany = prisma.chapterArtifactSyncCheckpoint.updateMany;
  let updateCalled = false;

  prisma.chapterArtifactSyncCheckpoint.findMany = async () => [];
  prisma.chapterArtifactSyncCheckpoint.updateMany = async () => {
    updateCalled = true;
    return { count: 0 };
  };

  try {
    const count = await reclaimStaleRunningArtifactCheckpoints();
    assert.equal(count, 0);
    assert.equal(updateCalled, false);
  } finally {
    prisma.chapterArtifactSyncCheckpoint.findMany = originalFindMany;
    prisma.chapterArtifactSyncCheckpoint.updateMany = originalUpdateMany;
  }
});

test("reclaimStaleRunningArtifactCheckpointsThrottled skips within throttle window", async () => {
  const originalFindMany = prisma.chapterArtifactSyncCheckpoint.findMany;
  const originalUpdateMany = prisma.chapterArtifactSyncCheckpoint.updateMany;
  let findCalls = 0;

  prisma.chapterArtifactSyncCheckpoint.findMany = async () => {
    findCalls += 1;
    return [];
  };
  prisma.chapterArtifactSyncCheckpoint.updateMany = async () => ({ count: 0 });

  try {
    resetArtifactCheckpointReclaimThrottleForTests();
    const first = await reclaimStaleRunningArtifactCheckpointsThrottled({
      limit: 10,
      throttleMs: 60_000,
    });
    const second = await reclaimStaleRunningArtifactCheckpointsThrottled({
      limit: 10,
      throttleMs: 60_000,
    });
    assert.equal(first, 0);
    assert.equal(second, 0);
    assert.equal(findCalls, 1);
  } finally {
    resetArtifactCheckpointReclaimThrottleForTests();
    prisma.chapterArtifactSyncCheckpoint.findMany = originalFindMany;
    prisma.chapterArtifactSyncCheckpoint.updateMany = originalUpdateMany;
  }
});
