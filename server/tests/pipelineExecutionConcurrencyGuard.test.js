const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");

const {
  NovelCorePipelineService,
} = require("../dist/services/novel/novelCorePipelineService.js");
const {
  PipelineExecutionAdmission,
  resolvePipelineExecutionConcurrency,
} = require("../dist/services/novel/pipeline/execution/PipelineExecutionAdmission.js");

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("pipeline execution concurrency rejects invalid values and enforces the hard cap", () => {
  assert.equal(resolvePipelineExecutionConcurrency(undefined), 1);
  assert.equal(resolvePipelineExecutionConcurrency("0"), 1);
  assert.equal(resolvePipelineExecutionConcurrency("2.5"), 1);
  assert.equal(resolvePipelineExecutionConcurrency("2"), 2);
  assert.equal(resolvePipelineExecutionConcurrency("99"), 4);
});

test("configured pipeline admission transfers permits without exceeding its limit", async () => {
  const admission = new PipelineExecutionAdmission(2);
  let active = 0;
  let maxActive = 0;
  const run = () => admission.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  });

  await Promise.all([run(), run(), run(), run()]);
  assert.equal(maxActive, 2);
  assert.equal(active, 0);
});

test("pipeline admission releases its permit when execution rejects", async () => {
  const admission = new PipelineExecutionAdmission(1);
  await assert.rejects(
    admission.run(async () => { throw new Error("synthetic pipeline failure"); }),
    /synthetic pipeline failure/,
  );
  assert.equal(await admission.run(async () => "next-job-ran"), "next-job-ran");
});

test("pipeline execution defaults to one active high-memory job per process", async () => {
  const service = new NovelCorePipelineService();
  const started = [];
  const releases = new Map();
  let active = 0;
  let maxActive = 0;

  service.pipelineJobLeaseService.claim = async () => ({ count: 1 });
  service.pipelineJobWriteService.ensureTerminalAfterUnhandledError = async () => {};
  service.executePipeline = async (jobId) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(jobId);
    await new Promise((resolve) => releases.set(jobId, resolve));
    active -= 1;
  };

  service.schedulePipelineExecution("pipeline-job-1", "novel-1", {
    startOrder: 1,
    endOrder: 10,
  });
  service.schedulePipelineExecution("pipeline-job-2", "novel-2", {
    startOrder: 1,
    endOrder: 10,
  });

  try {
    await waitFor(() => started.length >= 1, "first pipeline job never started");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 1, "the second pipeline job must wait for the process permit");

    releases.get(started[0])();
    await waitFor(() => started.length === 2, "second pipeline job never acquired the released permit");
    assert.equal(maxActive, 1);
  } finally {
    for (const release of releases.values()) release();
    await waitFor(() => active === 0, "pipeline test jobs did not settle");
  }
});

test("recovered pipeline jobs claim the database only after admission", async () => {
  const originalFindUnique = prisma.generationJob.findUnique;
  const service = new NovelCorePipelineService();
  const claimed = [];
  const started = [];
  const releases = new Map();

  service.pipelineJobWriteService.claimForResume = async (jobId) => {
    claimed.push(jobId);
    return { count: 1 };
  };
  service.pipelineJobLeaseService.claim = async () => ({ count: 1 });
  service.pipelineJobWriteService.ensureTerminalAfterUnhandledError = async () => {};
  service.executePipeline = async (jobId) => {
    started.push(jobId);
    await new Promise((resolve) => releases.set(jobId, resolve));
  };

  prisma.generationJob.findUnique = async ({ where }) => ({
    id: where.id,
    novelId: where.id === "recovered-job-1" ? "novel-1" : "novel-2",
    status: "queued",
    startOrder: 1,
    endOrder: 10,
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
    await Promise.all([
      service.resumePipelineJob("recovered-job-1"),
      service.resumePipelineJob("recovered-job-2"),
    ]);
    await waitFor(() => started.length === 1, "first recovered pipeline job never started");
    await new Promise((resolve) => setImmediate(resolve));
    const claimsWhileSecondWaits = [...claimed];

    releases.get("recovered-job-1")();
    await waitFor(() => started.length === 2, "second recovered pipeline job never started");
    releases.get("recovered-job-2")();
    await waitFor(
      () => !NovelCorePipelineService.activeJobIds.has("recovered-job-1")
        && !NovelCorePipelineService.activeJobIds.has("recovered-job-2"),
      "recovered pipeline test jobs did not settle",
    );

    assert.deepEqual(
      claimsWhileSecondWaits,
      ["recovered-job-1"],
      "a queued admission waiter must not clear or reserve its persisted lease early",
    );
    assert.deepEqual(claimed, ["recovered-job-1", "recovered-job-2"]);
  } finally {
    prisma.generationJob.findUnique = originalFindUnique;
  }
});
