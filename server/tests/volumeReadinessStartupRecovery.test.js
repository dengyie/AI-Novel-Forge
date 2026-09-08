const test = require("node:test");
const assert = require("node:assert/strict");

const {
  VolumeReadinessStartupRecoveryRunner,
} = require("../dist/services/novel/volume/readiness/application/VolumeReadinessStartupRecoveryRunner.js");

function plannedRun(runId, novelId, overrides = {}) {
  return {
    runId,
    novelId,
    wallMsUsed: 0,
    budget: { maxWallMinutes: 60 },
    ...overrides,
  };
}

test("startup readiness recovery globally serializes runs from different novels", async () => {
  let active = 0;
  let maxActive = 0;
  const started = [];
  const runner = new VolumeReadinessStartupRecoveryRunner({
    hydrate: async () => {},
    listPlanned: () => [
      plannedRun("run-a", "novel-a"),
      plannedRun("run-b", "novel-b"),
      plannedRun("run-c", "novel-c"),
    ],
    isWallExhausted: () => false,
    execute: async (runId) => {
      started.push(runId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    },
  });

  await runner.run();

  assert.deepEqual(started, ["run-a", "run-b", "run-c"]);
  assert.equal(maxActive, 1, "startup recovery must not amplify restart memory pressure");
});

test("startup readiness recovery executes only the newest listed run for one novel", async () => {
  const started = [];
  const runner = new VolumeReadinessStartupRecoveryRunner({
    hydrate: async () => {},
    // The run store returns updatedAt-descending order; first sibling is newest.
    listPlanned: () => [
      plannedRun("run-new", "novel-a"),
      plannedRun("run-old", "novel-a"),
      plannedRun("run-other", "novel-b"),
    ],
    isWallExhausted: () => false,
    execute: async (runId) => { started.push(runId); },
  });

  await runner.run();

  assert.deepEqual(started, ["run-new", "run-other"]);
});

test("startup readiness recovery skips wall-exhausted runs before same-novel deduplication", async () => {
  const started = [];
  const runner = new VolumeReadinessStartupRecoveryRunner({
    hydrate: async () => {},
    listPlanned: () => [
      plannedRun("run-new-exhausted", "novel-a", { wallMsUsed: 60_000 }),
      plannedRun("run-older-runnable", "novel-a"),
      plannedRun("run-b", "novel-b"),
    ],
    isWallExhausted: (run) => run.runId === "run-new-exhausted",
    execute: async (runId) => { started.push(runId); },
  });

  await runner.run();

  assert.deepEqual(
    started,
    ["run-older-runnable", "run-b"],
    "an exhausted newest sibling must not suppress a runnable older run",
  );
});

test("startup readiness recovery continues with the next novel after one execute failure", async () => {
  const started = [];
  const runner = new VolumeReadinessStartupRecoveryRunner({
    hydrate: async () => {},
    listPlanned: () => [
      plannedRun("run-fails", "novel-a"),
      plannedRun("run-recovers", "novel-b"),
    ],
    isWallExhausted: () => false,
    execute: async (runId) => {
      started.push(runId);
      if (runId === "run-fails") throw new Error("synthetic execute failure");
    },
  });

  await runner.run();

  assert.deepEqual(started, ["run-fails", "run-recovers"]);
});

test("startup readiness recovery honors shouldStop between serialized runs", async () => {
  const started = [];
  let stop = false;
  const runner = new VolumeReadinessStartupRecoveryRunner({
    hydrate: async () => {},
    listPlanned: () => [
      plannedRun("run-a", "novel-a"),
      plannedRun("run-b", "novel-b"),
    ],
    isWallExhausted: () => false,
    execute: async (runId) => {
      started.push(runId);
      stop = true;
    },
  });

  await runner.run(() => stop);

  assert.deepEqual(started, ["run-a"]);
});
