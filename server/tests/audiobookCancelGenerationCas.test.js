const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");

test("cancelTask does not write cancelRequestedAt into a newer generation", async () => {
  const stale = {
    id: "task-cancel-race",
    novelId: "novel-1",
    title: "取消竞态",
    status: "queued",
    progress: 12,
    currentStage: "queued",
    currentItemLabel: "排队中",
    cancelRequestedAt: null,
    m4bGenerationToken: "generation-a",
    progressJson: "{}",
  };
  const latest = { ...stale, m4bGenerationToken: "generation-b" };
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    findMany: prisma.audiobookTask.findMany,
    updateMany: prisma.audiobookTask.updateMany,
  };
  const claims = [];
  let reads = 0;
  let updates = 0;
  prisma.audiobookTask.findUnique = async () => (reads++ === 0 ? stale : latest);
  prisma.audiobookTask.findMany = async () => [];
  prisma.audiobookTask.updateMany = async (args) => {
    claims.push(args.where);
    updates += 1;
    // First CAS loses because a concurrent retry rotated generation A -> B.
    if (updates === 1) return { count: 0 };
    return { count: 1 };
  };

  const service = new AudiobookTaskService();
  service.getTask = async () => ({ id: "task-cancel-race", status: "cancelled" });
  try {
    await service.cancelTask("task-cancel-race", { via: "test" });
    assert.equal(claims.length, 3, "claim retry plus cancelled terminal CAS expected");
    assert.equal(claims[0].m4bGenerationToken, "generation-a");
    assert.equal(claims[1].m4bGenerationToken, "generation-b");
    assert.equal(claims[0].status, "queued");
    assert.equal(claims[1].status, "queued");
    assert.equal(claims[0].id, "task-cancel-race");
    assert.equal(claims[1].id, "task-cancel-race");
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.findMany = originals.findMany;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});
