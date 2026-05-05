const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { DirectorWorker } = require("../dist/workers/directorWorker.js");
const { DirectorTaskQueue } = require("../dist/workers/DirectorTaskQueue.js");
const { taskDispatcher } = require("../dist/workers/TaskDispatcher.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("director worker renews a leased execution while waiting for resource budget", async () => {
  const events = [];
  let leaseReturned = false;
  const lease = {
    runtimeId: "runtime-1",
    runtimeCommandId: "runtime-command-1",
    executionId: "execution-1",
    legacyCommandId: "legacy-command-1",
    taskId: "task-1",
    novelId: "novel-1",
    commandType: "continue",
    stepType: "resume_from_checkpoint",
    resourceClass: "writer",
  };
  const command = {
    id: "legacy-command-1",
    taskId: "task-1",
    novelId: "novel-1",
    commandType: "continue",
  };

  const queue = Object.create(DirectorTaskQueue.prototype);
  queue.workerId = "test-worker";
  queue.leaseMs = 300;
  queue.staleScanMs = Number.MAX_SAFE_INTEGER;
  queue.executionSlots = 1;
  queue.pollMs = 1;

  queue.leaseNext = async () => {
    if (leaseReturned) return null;
    leaseReturned = true;
    events.push("lease");
    return { lease, legacyCommand: command };
  };
  queue.startLeaseRenewal = (l, slotId) => {
    events.push("start-renewal");
    return () => { events.push("stop-renewal"); };
  };
  queue.acquireResourceGate = async (novelId, rc) => {
    events.push(`acquire-gate:${novelId}:${rc}`);
    await delay(150);
    events.push("gate-acquired");
  };
  queue.releaseResourceGate = (novelId, rc) => {
    events.push(`release-gate:${novelId}:${rc}`);
  };
  queue.markRunning = async () => {
    events.push("mark-running");
  };
  queue.completeTask = async () => {
    events.push("complete");
  };
  queue.cancelTask = async () => {
    events.push("cancel");
  };
  queue.failTask = async () => {
    events.push("fail");
  };
  queue.waitForWork = async () => {
    await delay(1);
  };

  const executionService = {
    executeCommand: async () => {
      events.push("execute");
      return "completed";
    },
  };

  const worker = new DirectorWorker({ queue, executionService });
  const didWork = await worker.tick("slot-1");

  assert.equal(didWork, true);
  assert.ok(events.includes("lease"), "should lease a task");
  assert.ok(events.includes("start-renewal"), "should start lease renewal");
  assert.ok(events.includes("acquire-gate:novel-1:writer"), "should acquire per-novel resource gate");
  assert.ok(events.includes("mark-running"), "should mark as running");
  assert.ok(events.includes("execute"), "should execute the command");
  assert.ok(events.includes("complete"), "should complete the task");
  assert.ok(events.includes("release-gate:novel-1:writer"), "should release per-novel resource gate");
  assert.ok(events.includes("stop-renewal"), "should stop lease renewal");
  assert.ok(events.indexOf("start-renewal") < events.indexOf("acquire-gate:novel-1:writer"),
    "renewal should start before waiting for resource gate");
});

test("director task queue leases through runtime execution service", async (t) => {
  const originalFindUnique = prisma.directorRunCommand.findUnique;
  const runtimeCalls = [];
  const lease = {
    runtimeId: "runtime-1",
    runtimeCommandId: "runtime-command-1",
    executionId: "execution-1",
    legacyCommandId: "legacy-command-1",
    taskId: "task-1",
    novelId: "novel-1",
    commandType: "continue",
    stepType: "resume_from_checkpoint",
    resourceClass: "writer",
  };
  const legacyCommand = {
    id: "legacy-command-1",
    taskId: "task-1",
    novelId: "novel-1",
    commandType: "continue",
    status: "leased",
  };
  const runtimeExecutionService = {
    leaseNextExecution: async (input) => {
      runtimeCalls.push(input);
      return lease;
    },
    markExecutionRunning: async () => true,
    renewExecutionLease: async () => true,
    markExecutionSucceeded: async () => {},
    markExecutionCancelled: async () => {},
    markExecutionFailed: async () => {},
    recoverStaleExecutions: async () => 0,
  };

  prisma.directorRunCommand.findUnique = async ({ where }) => {
    assert.equal(where.id, "legacy-command-1");
    return legacyCommand;
  };
  t.after(() => {
    prisma.directorRunCommand.findUnique = originalFindUnique;
  });

  const queue = new DirectorTaskQueue({
    workerId: "worker-a",
    leaseMs: 1234,
    staleScanMs: Number.MAX_SAFE_INTEGER,
  }, {
    runtimeExecutionService,
  });

  const leased = await queue.leaseNext("slot-1");

  assert.equal(runtimeCalls.length, 1);
  assert.deepEqual(runtimeCalls[0], {
    workerId: "worker-a",
    slotId: "slot-1",
    leaseMs: 1234,
  });
  assert.equal(leased.lease, lease);
  assert.equal(leased.legacyCommand, legacyCommand);
});

test("task dispatcher notifies waiting slots immediately", async () => {
  const start = Date.now();
  const waitPromise = taskDispatcher.waitForSignal(5000);
  await delay(10);
  taskDispatcher.notify({ commandType: "continue" });
  const wasSignaled = await waitPromise;
  const elapsed = Date.now() - start;
  assert.equal(wasSignaled, true, "should be woken by signal");
  assert.ok(elapsed < 1000, `should wake quickly, took ${elapsed}ms`);
});

test("task dispatcher returns false on timeout", async () => {
  const wasSignaled = await taskDispatcher.waitForSignal(50);
  assert.equal(wasSignaled, false, "should return false on timeout");
});
