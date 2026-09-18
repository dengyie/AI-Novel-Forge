const test = require("node:test");
const assert = require("node:assert/strict");
const { RagWorkerManager } = require("../dist/runtime/RagWorkerManager.js");
const { prisma } = require("../dist/db/prisma.js");
const { ragConfig } = require("../dist/config/rag.js");

function installWorker(manager, overrides = {}) {
  let killCount = 0;
  const worker = {
    pid: 999_991,
    kill: () => {
      killCount += 1;
      return true;
    },
  };
  manager.worker = worker;
  manager.lastHeartbeatAt = overrides.lastHeartbeatAt ?? Date.now();
  manager.receivedHeartbeat = overrides.receivedHeartbeat ?? false;
  return { worker, getKillCount: () => killCount };
}

test("RAG watchdog waits for the first heartbeat", () => {
  const manager = new RagWorkerManager();
  const fake = installWorker(manager, {
    lastHeartbeatAt: Date.now() - 10 * 60_000,
    receivedHeartbeat: false,
  });

  manager.checkStalled();

  assert.equal(fake.getKillCount(), 0);
  assert.equal(manager.worker, fake.worker);
});

test("RAG watchdog kills a stalled worker and requeues running jobs", async () => {
  const manager = new RagWorkerManager();
  const fake = installWorker(manager, {
    lastHeartbeatAt: Date.now() - 3 * 60_000,
    receivedHeartbeat: true,
  });
  const originalUpdateMany = prisma.ragIndexJob.updateMany;
  const originalSetTimeout = global.setTimeout;
  let updateArgs = null;
  global.setTimeout = () => ({ unref() {} });
  prisma.ragIndexJob.updateMany = async (args) => {
    updateArgs = args;
    return { count: 2 };
  };

  try {
    manager.checkStalled();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fake.getKillCount(), 1);
    assert.equal(manager.worker, null);
    assert.deepEqual(updateArgs.where, { status: "running" });
    assert.equal(updateArgs.data.status, "queued");
    assert.equal(updateArgs.data.lastError, "RAG worker stalled; job requeued.");
  } finally {
    global.setTimeout = originalSetTimeout;
    prisma.ragIndexJob.updateMany = originalUpdateMany;
    await manager.shutdown();
  }
});

test("RAG worker exit requeues running jobs instead of leaving them stuck", async () => {
  const manager = new RagWorkerManager();
  const worker = { pid: 999_992 };
  const logStream = { endCalled: false, end() { this.endCalled = true; } };
  let resetReason = null;
  manager.worker = worker;
  manager.resetRunningJobs = async (reason) => {
    resetReason = reason;
  };

  manager.handleWorkerExit(worker, logStream, 137, "SIGKILL");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.worker, null);
  assert.equal(resetReason, "exited");
  assert.equal(logStream.endCalled, true);
});

test("RAG manager keeps a running index job alive instead of sending idle", async () => {
  const manager = new RagWorkerManager();
  const originalCount = prisma.ragIndexJob.count;
  const originalEnabled = ragConfig.enabled;
  let countArgs = null;
  let idleSent = false;
  manager.worker = {
    pid: 999_993,
    send: (message) => {
      if (message.type === "idle") idleSent = true;
      return true;
    },
  };
  prisma.ragIndexJob.count = async (args) => {
    countArgs = args;
    return 1;
  };
  ragConfig.enabled = true;

  try {
    await manager.pollTick();
    assert.deepEqual(countArgs, { where: { status: { in: ["queued", "running"] } } });
    assert.equal(idleSent, false);
  } finally {
    prisma.ragIndexJob.count = originalCount;
    ragConfig.enabled = originalEnabled;
    manager.worker = null;
    await manager.shutdown();
  }
});
