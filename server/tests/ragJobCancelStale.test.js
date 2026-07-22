const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { RagJobCleanupService } = require("../dist/services/rag/RagJobCleanupService.js");

test("cancelStaleActiveJobs cancels old queued and stuck running jobs", async () => {
  const service = new RagJobCleanupService();
  const originalFindMany = prisma.ragIndexJob.findMany;
  const originalUpdateMany = prisma.ragIndexJob.updateMany;
  const findCalls = [];
  const updateCalls = [];

  prisma.ragIndexJob.findMany = async (args) => {
    findCalls.push(args);
    if (args.where.status === "queued") {
      return [{ id: "q1" }, { id: "q2" }];
    }
    if (args.where.status === "running") {
      return [{ id: "r1" }];
    }
    return [];
  };
  prisma.ragIndexJob.updateMany = async (args) => {
    updateCalls.push(args);
    return { count: args.where.id.in.length };
  };

  try {
    const result = await service.cancelStaleActiveJobs({
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      runningMaxAgeMs: 30 * 60 * 1000,
      limit: 100,
    });
    assert.deepEqual(result, { cancelledQueued: 2, cancelledRunning: 1 });
    assert.equal(findCalls.length, 2);
    assert.equal(updateCalls.length, 2);
    assert.equal(updateCalls[0].data.status, "cancelled");
    assert.match(updateCalls[0].data.lastError, /stale_queued_max_age/);
    assert.equal(updateCalls[1].data.status, "cancelled");
    assert.match(updateCalls[1].data.lastError, /stale_running_max_age/);
  } finally {
    prisma.ragIndexJob.findMany = originalFindMany;
    prisma.ragIndexJob.updateMany = originalUpdateMany;
  }
});

test("cancelStaleActiveJobs is no-op when queue is clean", async () => {
  const service = new RagJobCleanupService();
  const originalFindMany = prisma.ragIndexJob.findMany;
  const originalUpdateMany = prisma.ragIndexJob.updateMany;
  let updateCalled = false;

  prisma.ragIndexJob.findMany = async () => [];
  prisma.ragIndexJob.updateMany = async () => {
    updateCalled = true;
    return { count: 0 };
  };

  try {
    const result = await service.cancelStaleActiveJobs({ limit: 50 });
    assert.deepEqual(result, { cancelledQueued: 0, cancelledRunning: 0 });
    assert.equal(updateCalled, false);
  } finally {
    prisma.ragIndexJob.findMany = originalFindMany;
    prisma.ragIndexJob.updateMany = originalUpdateMany;
  }
});

test("countActiveByOwnerType groups active jobs", async () => {
  const service = new RagJobCleanupService();
  const originalGroupBy = prisma.ragIndexJob.groupBy;
  prisma.ragIndexJob.groupBy = async () => ([
    { ownerType: "chapter", status: "queued", _count: { _all: 12 } },
    { ownerType: "world", status: "running", _count: { _all: 1 } },
  ]);

  try {
    const rows = await service.countActiveByOwnerType();
    assert.deepEqual(rows, [
      { ownerType: "chapter", status: "queued", count: 12 },
      { ownerType: "world", status: "running", count: 1 },
    ]);
  } finally {
    prisma.ragIndexJob.groupBy = originalGroupBy;
  }
});
