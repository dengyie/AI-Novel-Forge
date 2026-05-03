const test = require("node:test");
const assert = require("node:assert/strict");

const { DirectorWorker } = require("../dist/workers/directorWorker.js");

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
  const commandService = {
    renewLease: async () => {
      events.push("renew-legacy");
    },
    markCommandRunning: async () => {
      events.push("mark-legacy-running");
    },
    getCommandById: async () => command,
    markCommandCancelled: async () => {},
    markCommandSucceeded: async () => {
      events.push("mark-legacy-succeeded");
    },
    markCommandFailed: async () => {},
  };
  const executionService = {
    executeCommand: async () => {
      events.push("execute-command");
      return "completed";
    },
  };
  const runtimeExecutionService = {
    leaseNextExecution: async () => {
      if (leaseReturned) {
        return null;
      }
      leaseReturned = true;
      events.push("lease-runtime");
      return lease;
    },
    renewExecutionLease: async () => {
      events.push("renew-runtime");
    },
    markExecutionRunning: async () => {
      events.push("mark-runtime-running");
    },
    markExecutionSucceeded: async () => {
      events.push("mark-runtime-succeeded");
    },
    markExecutionCancelled: async () => {},
    markExecutionFailed: async () => {},
    recoverStaleExecutions: async () => 0,
  };
  const reconciliationService = {
    reconcile: async () => ({
      staleLeaseCount: 0,
      closedStepCount: 0,
      requeuedDanglingTaskCount: 0,
      adoptedLegacyCommandCount: 0,
    }),
  };
  const resourceBudget = {
    run: async (_resourceClass, operation) => {
      await delay(150);
      return operation();
    },
  };
  const worker = new DirectorWorker(
    commandService,
    executionService,
    runtimeExecutionService,
    reconciliationService,
    resourceBudget,
    {
      workerId: "test-worker",
      pollMs: 1,
      leaseMs: 300,
      staleScanMs: Number.MAX_SAFE_INTEGER,
      executionSlots: 1,
    },
  );

  const didWork = await worker.tick("slot-1");

  assert.equal(didWork, true);
  assert.ok(events.indexOf("renew-runtime") > events.indexOf("lease-runtime"));
  assert.ok(events.indexOf("renew-runtime") < events.indexOf("mark-runtime-running"));
  assert.ok(events.indexOf("renew-legacy") < events.indexOf("mark-legacy-running"));
  assert.ok(events.includes("mark-runtime-succeeded"));
  assert.ok(events.includes("mark-legacy-succeeded"));
});
