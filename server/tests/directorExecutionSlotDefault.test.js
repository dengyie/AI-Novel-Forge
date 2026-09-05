const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const { DirectorTaskQueue } = require("../dist/workers/DirectorTaskQueue.js");

const original = {
  cpus: os.cpus,
  availableParallelism: os.availableParallelism,
  availableMemory: process.availableMemory,
  envSlots: process.env.DIRECTOR_WORKER_EXECUTION_SLOTS,
};

test.afterEach(() => {
  os.cpus = original.cpus;
  os.availableParallelism = original.availableParallelism;
  process.availableMemory = original.availableMemory;
  if (original.envSlots === undefined) delete process.env.DIRECTOR_WORKER_EXECUTION_SLOTS;
  else process.env.DIRECTOR_WORKER_EXECUTION_SLOTS = original.envSlots;
});

test("default director slots remain one when host pressure is invisible inside the container", { concurrency: false }, () => {
  delete process.env.DIRECTOR_WORKER_EXECUTION_SLOTS;
  os.cpus = () => Array.from({ length: 64 }, () => ({}));
  os.availableParallelism = () => 8;
  process.availableMemory = () => Math.floor(2.9 * 1024 ** 3);

  const queue = new DirectorTaskQueue();

  assert.equal(
    queue.executionSlots,
    1,
    "global host OOM cannot be inferred from container-visible memory; concurrency must be opt-in",
  );
});

test("an explicit positive director slot setting overrides the conservative default", { concurrency: false }, () => {
  process.env.DIRECTOR_WORKER_EXECUTION_SLOTS = "3";
  os.availableParallelism = () => 1;
  process.availableMemory = () => 512 * 1024 ** 2;

  const queue = new DirectorTaskQueue();

  assert.equal(queue.executionSlots, 3);
});

test("fractional director slot settings fall back to the conservative integer default", { concurrency: false }, () => {
  process.env.DIRECTOR_WORKER_EXECUTION_SLOTS = "0.5";

  const queue = new DirectorTaskQueue();

  assert.equal(queue.executionSlots, 1);
});

test("director slot settings are capped before runner arrays are allocated", { concurrency: false }, () => {
  process.env.DIRECTOR_WORKER_EXECUTION_SLOTS = "1000000";

  const queue = new DirectorTaskQueue();

  assert.equal(queue.executionSlots, 4);
});
