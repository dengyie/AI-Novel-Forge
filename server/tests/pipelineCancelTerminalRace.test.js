const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { NovelCorePipelineService } = require(
  "../dist/services/novel/novelCorePipelineService.js"
);

function matchesWhere(row, where) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

async function runCancellationRace({ initialLeaseOwner, concurrentTransition }) {
  const original = {
    findUnique: prisma.generationJob.findUnique,
    update: prisma.generationJob.update,
    updateMany: prisma.generationJob.updateMany,
  };
  let row = {
    id: "job-race",
    status: "running",
    leaseOwner: initialLeaseOwner,
    finishedAt: null,
    cancelRequestedAt: null,
  };
  let firstRead = true;
  const updateManyInputs = [];
  let unconditionalUpdateCount = 0;

  prisma.generationJob.findUnique = async () => {
    const snapshot = { ...row };
    if (firstRead) {
      firstRead = false;
      row = { ...row, ...concurrentTransition };
    }
    return snapshot;
  };
  prisma.generationJob.updateMany = async (input) => {
    updateManyInputs.push(input);
    if (!matchesWhere(row, input.where)) {
      return { count: 0 };
    }
    row = { ...row, ...input.data };
    return { count: 1 };
  };
  prisma.generationJob.update = async (input) => {
    unconditionalUpdateCount += 1;
    row = { ...row, ...input.data };
    return { ...row };
  };

  try {
    const result = await new NovelCorePipelineService().cancelPipelineJob("job-race");
    return {
      result,
      row,
      updateManyInputs,
      unconditionalUpdateCount,
    };
  } finally {
    prisma.generationJob.findUnique = original.findUnique;
    prisma.generationJob.update = original.update;
    prisma.generationJob.updateMany = original.updateMany;
  }
}

test("running cancellation does not overwrite a concurrent succeeded terminal row", async () => {
  const finishedAt = new Date("2026-07-26T10:00:00.000Z");
  const outcome = await runCancellationRace({
    initialLeaseOwner: null,
    concurrentTransition: {
      status: "succeeded",
      finishedAt,
    },
  });

  assert.equal(outcome.unconditionalUpdateCount, 0);
  assert.equal(outcome.updateManyInputs.length, 1);
  assert.deepEqual(outcome.updateManyInputs[0].where, {
    id: "job-race",
    status: "running",
    finishedAt: null,
  });
  assert.equal(outcome.row.status, "succeeded");
  assert.equal(outcome.row.finishedAt, finishedAt);
  assert.equal(outcome.row.cancelRequestedAt, null);
  assert.equal(outcome.result.status, "succeeded");
});

test("running cancellation remains effective after lease takeover", async () => {
  const outcome = await runCancellationRace({
    initialLeaseOwner: "pipeline-owner-a",
    concurrentTransition: {
      status: "running",
      leaseOwner: "pipeline-owner-b",
    },
  });

  assert.equal(outcome.unconditionalUpdateCount, 0);
  assert.equal(outcome.updateManyInputs.length, 1);
  assert.equal(outcome.row.status, "cancelled");
  assert.equal(outcome.row.leaseOwner, "pipeline-owner-b");
  assert.ok(outcome.row.cancelRequestedAt instanceof Date);
  assert.equal(outcome.updateManyInputs[0].where.status, "running");
  assert.equal("leaseOwner" in outcome.updateManyInputs[0].where, false);
});
