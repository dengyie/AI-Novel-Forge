const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { prisma } = require("../dist/db/prisma.js");
const {
  PipelineJobWriteService,
} = require("../dist/services/novel/pipeline/state/PipelineJobWriteService.js");
const {
  NovelCorePipelineService,
} = require("../dist/services/novel/novelCorePipelineService.js");
const {
  recoverPipelineJob,
} = require("../dist/services/novel/pipeline/recovery/PipelineJobRecoveryPolicy.js");
const {
  PIPELINE_LEASE_LOST_MESSAGE,
} = require("../dist/services/novel/pipelineJobTerminalGuard.js");

test("beginExecution uses status, cancellation, terminal and owner CAS guards", async () => {
  const originalUpdateMany = prisma.generationJob.updateMany;
  const calls = [];
  prisma.generationJob.updateMany = async (input) => {
    calls.push(input);
    return { count: 0 };
  };

  try {
    const service = new PipelineJobWriteService();
    const now = new Date("2026-07-27T10:00:00.000Z");
    await service.beginExecution({
      jobId: "job-cancelled-before-start",
      leaseOwner: null,
      startedAt: now,
      now,
    });
    await service.beginExecution({
      jobId: "job-owned",
      leaseOwner: "pipeline-owner-a",
      startedAt: now,
      now,
    });

    assert.deepEqual(calls[0].where, {
      id: "job-cancelled-before-start",
      status: { in: ["queued", "running"] },
      leaseOwner: null,
      cancelRequestedAt: null,
      finishedAt: null,
    });
    assert.deepEqual(calls[1].where, {
      id: "job-owned",
      status: "running",
      leaseOwner: "pipeline-owner-a",
      cancelRequestedAt: null,
      finishedAt: null,
    });
  } finally {
    prisma.generationJob.updateMany = originalUpdateMany;
  }
});

test("claimForResume cannot clear cancellation or an unexpired owner lease", async () => {
  const originalUpdateMany = prisma.generationJob.updateMany;
  let input = null;
  prisma.generationJob.updateMany = async (nextInput) => {
    input = nextInput;
    return { count: 0 };
  };

  try {
    const service = new PipelineJobWriteService();
    const now = new Date("2026-07-27T10:00:00.000Z");
    const result = await service.claimForResume("job-resume-race", now);

    assert.equal(result.count, 0);
    assert.deepEqual(input.where, {
      id: "job-resume-race",
      status: { in: ["queued", "running"] },
      cancelRequestedAt: null,
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lt: now } },
      ],
      finishedAt: null,
    });
    assert.equal(input.data.cancelRequestedAt, null);
    assert.equal(input.data.leaseOwner, null);
  } finally {
    prisma.generationJob.updateMany = originalUpdateMany;
  }
});

test("startup recovery mutations only apply to recoverable canonical rows", async () => {
  const originalUpdateMany = prisma.generationJob.updateMany;
  const calls = [];
  prisma.generationJob.updateMany = async (input) => {
    calls.push(input);
    return { count: 0 };
  };

  try {
    const service = new PipelineJobWriteService();
    const now = new Date("2026-07-27T10:02:00.000Z");
    await service.markFailedIfRecoverable("job-failed-recovery", "resume failed", now);
    await service.markPendingManualRecoveryIfRecoverable(
      "job-manual-recovery",
      "manual recovery required",
      now,
    );
    await service.markCancelledIfPending("job-pending-cancel", now);

    const recoverableWhere = (jobId) => ({
      id: jobId,
      status: { in: ["queued", "running"] },
      cancelRequestedAt: null,
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lt: now } },
      ],
      finishedAt: null,
    });
    assert.deepEqual(calls[0].where, recoverableWhere("job-failed-recovery"));
    assert.deepEqual(calls[1].where, recoverableWhere("job-manual-recovery"));
    assert.deepEqual(calls[2].where, {
      id: "job-pending-cancel",
      status: "cancelled",
      cancelRequestedAt: { not: null },
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lt: now } },
      ],
      finishedAt: null,
    });
  } finally {
    prisma.generationJob.updateMany = originalUpdateMany;
  }
});

test("startup cancellation recovery leaves a live owner lease and finalizes only unleased or expired rows", async () => {
  const originalUpdateMany = prisma.generationJob.updateMany;
  const now = new Date("2026-07-27T10:02:00.000Z");
  const leases = new Map([
    ["job-live", new Date("2026-07-27T10:03:00.000Z")],
    ["job-unleased", null],
    ["job-expired", new Date("2026-07-27T10:01:00.000Z")],
  ]);
  prisma.generationJob.updateMany = async (input) => {
    const leaseExpiresAt = leases.get(input.where.id);
    const matchesRecoveryLease = leaseExpiresAt == null || leaseExpiresAt < now;
    return { count: matchesRecoveryLease ? 1 : 0 };
  };

  try {
    const service = new PipelineJobWriteService();
    assert.equal((await service.markCancelledIfPending("job-live", now)).count, 0);
    assert.equal((await service.markCancelledIfPending("job-unleased", now)).count, 1);
    assert.equal((await service.markCancelledIfPending("job-expired", now)).count, 1);
  } finally {
    prisma.generationJob.updateMany = originalUpdateMany;
  }
});

test("failure and cancellation settlement require the executing owner", async () => {
  const originalUpdateMany = prisma.generationJob.updateMany;
  const calls = [];
  prisma.generationJob.updateMany = async (input) => {
    calls.push(input);
    return { count: 1 };
  };

  try {
    const service = new PipelineJobWriteService();
    const now = new Date("2026-07-27T10:05:00.000Z");
    await service.settleCancelled({
      jobId: "job-cancel",
      leaseOwner: "pipeline-owner-a",
      payload: "cancel-payload",
      now,
    });
    await service.settleFailed({
      jobId: "job-failed",
      leaseOwner: null,
      error: "provider unavailable",
      payload: "failed-payload",
      now,
    });

    assert.deepEqual(calls[0].where, {
      id: "job-cancel",
      finishedAt: null,
      leaseOwner: "pipeline-owner-a",
      OR: [
        { status: "running" },
        { status: "cancelled", cancelRequestedAt: { not: null } },
      ],
    });
    assert.deepEqual(calls[1].where, {
      id: "job-failed",
      status: "running",
      leaseOwner: null,
      cancelRequestedAt: null,
      finishedAt: null,
    });
  } finally {
    prisma.generationJob.updateMany = originalUpdateMany;
  }
});

test("unhandled execution failure cannot terminalize a replacement owner", async () => {
  const originalFindUnique = prisma.generationJob.findUnique;
  const originalUpdateMany = prisma.generationJob.updateMany;
  let updateInput = null;
  prisma.generationJob.findUnique = async () => ({
    status: "running",
    cancelRequestedAt: null,
  });
  prisma.generationJob.updateMany = async (input) => {
    updateInput = input;
    return { count: 0 };
  };

  try {
    const service = new PipelineJobWriteService();
    await service.ensureTerminalAfterUnhandledError(
      "job-owner-race",
      "pipeline-owner-old",
      new Error("late failure"),
    );

    assert.deepEqual(updateInput.where, {
      id: "job-owner-race",
      status: "running",
      leaseOwner: "pipeline-owner-old",
    });
    assert.equal(updateInput.data.status, "failed");
  } finally {
    prisma.generationJob.findUnique = originalFindUnique;
    prisma.generationJob.updateMany = originalUpdateMany;
  }
});

test("failed settlement CAS miss closes a concurrent cancellation instead", async () => {
  const originalFindUnique = prisma.generationJob.findUnique;
  prisma.generationJob.findUnique = async () => ({
    status: "cancelled",
    cancelRequestedAt: new Date("2026-07-27T10:06:00.000Z"),
  });
  let failedCalls = 0;
  let cancelledCalls = 0;
  const host = {
    leaseOwner: "pipeline-owner-a",
    settleJobFailed: async () => {
      failedCalls += 1;
      return false;
    },
    settleJobCancelled: async () => {
      cancelledCalls += 1;
      return true;
    },
    stringifyPipelinePayload: (payload) => JSON.stringify(payload),
  };

  try {
    await recoverPipelineJob({
      error: new Error("permanent chapter failure"),
      host,
      jobId: "job-failure-cancel-race",
      novelId: "novel-1",
      options: { startOrder: 1, endOrder: 1 },
      runtimePayload: { jobTransportAutoRetryCount: 0 },
      totalRetryCount: 0,
      qualityAlertDetails: [],
      replanAlertDetails: [],
      genreBeatAlertDetails: [],
      recoverableRepairDetails: [],
    });

    assert.equal(failedCalls, 1);
    assert.equal(cancelledCalls, 1);
  } finally {
    prisma.generationJob.findUnique = originalFindUnique;
  }
});

test("lease-lost recovery settles a canonical cancellation owned by the same worker", async () => {
  const originalFindUnique = prisma.generationJob.findUnique;
  prisma.generationJob.findUnique = async () => ({
    status: "cancelled",
    cancelRequestedAt: new Date("2026-07-29T10:06:00.000Z"),
  });
  let cancelledCalls = 0;
  const host = {
    leaseOwner: "pipeline-owner-a",
    settleJobCancelled: async () => {
      cancelledCalls += 1;
      return true;
    },
    stringifyPipelinePayload: (payload) => JSON.stringify(payload),
  };

  try {
    await recoverPipelineJob({
      error: new Error(PIPELINE_LEASE_LOST_MESSAGE),
      host,
      jobId: "job-remote-cancel",
      novelId: "novel-1",
      options: { startOrder: 1, endOrder: 1 },
      runtimePayload: { jobTransportAutoRetryCount: 0 },
      totalRetryCount: 0,
      qualityAlertDetails: [],
      replanAlertDetails: [],
      genreBeatAlertDetails: [],
      recoverableRepairDetails: [],
    });

    assert.equal(cancelledCalls, 1);
  } finally {
    prisma.generationJob.findUnique = originalFindUnique;
  }
});

test("lease-lost recovery cannot settle cancellation after ownership moved", async () => {
  const originalFindUnique = prisma.generationJob.findUnique;
  prisma.generationJob.findUnique = async () => ({
    status: "cancelled",
    cancelRequestedAt: new Date("2026-07-29T10:07:00.000Z"),
  });
  let cancelledCalls = 0;
  const host = {
    leaseOwner: "pipeline-owner-old",
    settleJobCancelled: async () => {
      cancelledCalls += 1;
      return false;
    },
    stringifyPipelinePayload: (payload) => JSON.stringify(payload),
  };

  try {
    await recoverPipelineJob({
      error: new Error(PIPELINE_LEASE_LOST_MESSAGE),
      host,
      jobId: "job-taken-over",
      novelId: "novel-1",
      options: { startOrder: 1, endOrder: 1 },
      runtimePayload: { jobTransportAutoRetryCount: 0 },
      totalRetryCount: 0,
      qualityAlertDetails: [],
      replanAlertDetails: [],
      genreBeatAlertDetails: [],
      recoverableRepairDetails: [],
    });

    assert.equal(cancelledCalls, 1);
  } finally {
    prisma.generationJob.findUnique = originalFindUnique;
  }
});

test("resumePipelineJob does not schedule after the canonical resume CAS misses", async () => {
  const originalFindUnique = prisma.generationJob.findUnique;
  prisma.generationJob.findUnique = async () => ({
    id: "job-resume-race",
    novelId: "novel-1",
    status: "queued",
    startOrder: 1,
    endOrder: 2,
    runMode: "fast",
    autoReview: true,
    autoRepair: true,
    skipCompleted: true,
    qualityThreshold: null,
    repairMode: "light_repair",
    maxRetries: 1,
    payload: null,
    error: null,
  });

  try {
    const service = new NovelCorePipelineService();
    let scheduleCalls = 0;
    service.pipelineJobWriteService.claimForResume = async () => ({ count: 0 });
    service.schedulePipelineExecution = () => {
      scheduleCalls += 1;
    };

    await service.resumePipelineJob("job-resume-race");
    assert.equal(scheduleCalls, 0);
  } finally {
    prisma.generationJob.findUnique = originalFindUnique;
  }
});

test("pipeline lifecycle ownership has no unconditional generationJob.update facade", () => {
  const sourceRoot = path.resolve(__dirname, "../src/services/novel");
  const files = [
    "novelCorePipelineService.ts",
    "pipeline/execution/PipelineJobExecutor.ts",
    "pipeline/recovery/PipelineJobRecoveryPolicy.ts",
    "pipeline/state/PipelineJobWriteService.ts",
  ];
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");
    assert.equal(
      source.includes("generationJob.update({"),
      false,
      `${relativePath} must use lifecycle CAS writes`,
    );
    assert.equal(source.includes("updateJobSafe"), false, `${relativePath} must not restore updateJobSafe`);
  }
});
