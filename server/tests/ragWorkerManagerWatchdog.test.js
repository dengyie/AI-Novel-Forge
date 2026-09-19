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

test("RAG watchdog kills a child that never sends its first heartbeat", () => {
  const manager = new RagWorkerManager();
  const fake = installWorker(manager, {
    lastHeartbeatAt: Date.now() - 10 * 60_000,
    receivedHeartbeat: false,
  });

  manager.checkStalled();

  assert.equal(fake.getKillCount(), 1);
  assert.equal(manager.worker, fake.worker);
});

test("RAG manager keeps a stopping child until exit and recovery completes", async () => {
  const manager = new RagWorkerManager();
  const worker = {
    pid: 999_994,
    killCount: 0,
    kill() {
      this.killCount += 1;
      return true;
    },
  };
  manager.worker = worker;
  manager.lastHeartbeatAt = Date.now() - 3 * 60_000;
  manager.receivedHeartbeat = true;

  let releaseRecovery;
  const recovery = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  manager.resetRunningJobs = async () => {
    await recovery;
    manager.recoveryPending = false;
  };

  manager.checkStalled();
  assert.equal(manager.worker, worker);
  assert.equal(worker.killCount, 1);

  const logStream = { end() {} };
  manager.handleWorkerExit(worker, logStream, 137, "SIGKILL");
  assert.equal(manager.worker, null);
  assert.equal(manager.recoveryPending, true);

  let spawned = false;
  manager.spawnWorkerIfNeeded = async () => {
    spawned = true;
  };
  await manager.pollTick();
  assert.equal(spawned, false);

  releaseRecovery();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.recoveryPending, false);
});

test("RAG disable sends a bounded kill when shutdown IPC is accepted but child hangs", async () => {
  const manager = new RagWorkerManager();
  const worker = {
    pid: 999_995,
    send(_message, callback) {
      callback?.();
      return true;
    },
    killCount: 0,
    kill(signal) {
      this.killCount += 1;
      this.lastSignal = signal;
      return true;
    },
  };
  manager.worker = worker;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback) => {
    const timer = { callback, unref() {} };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  try {
    const stopPromise = manager.disable();
    assert.equal(worker.killCount, 0);
    assert.ok(timers.length >= 1);
    timers.at(-1).callback();
    assert.equal(worker.killCount, 1);
    assert.equal(worker.lastSignal, "SIGKILL");
    await stopPromise;
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    manager.worker = null;
    await manager.shutdown();
  }
});

test("RAG refresh stops the current worker before allowing a replacement", async () => {
  const manager = new RagWorkerManager();
  const worker = {
    pid: 999_996,
    send(_message, callback) {
      callback?.();
      return true;
    },
    killCount: 0,
    kill(signal) {
      this.killCount += 1;
      this.lastSignal = signal;
      return true;
    },
  };
  manager.worker = worker;
  manager.workerState = "running";
  manager.desiredAlive = true;

  const originalEnabled = ragConfig.enabled;
  const originalUpdateMany = prisma.ragIndexJob.updateMany;
  const originalCount = prisma.ragIndexJob.count;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  let updateCount = 0;
  let spawnCount = 0;
  ragConfig.enabled = true;
  prisma.ragIndexJob.updateMany = async () => {
    updateCount += 1;
    return { count: 1 };
  };
  prisma.ragIndexJob.count = async () => 1;
  manager.spawnWorkerIfNeeded = async () => {
    spawnCount += 1;
  };
  global.setTimeout = (callback) => {
    const timer = { callback, unref() {} };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  try {
    let refreshed = false;
    const refreshPromise = manager.refresh().then(() => {
      refreshed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.killCount, 0);
    assert.equal(manager.worker, worker);
    assert.equal(spawnCount, 0);

    timers.at(-1).callback();
    assert.equal(worker.killCount, 1);
    assert.equal(worker.lastSignal, "SIGKILL");
    assert.equal(manager.worker, worker);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshed, false);

    manager.handleWorkerExit(worker, { end() {} }, 137, "SIGKILL");
    await refreshPromise;

    assert.equal(manager.worker, null);
    assert.equal(updateCount, 1);
    assert.equal(spawnCount, 1);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    prisma.ragIndexJob.updateMany = originalUpdateMany;
    prisma.ragIndexJob.count = originalCount;
    ragConfig.enabled = originalEnabled;
    manager.worker = null;
    await manager.shutdown();
  }
});

test("RAG refresh does not respawn a worker when the latest settings disable RAG", async () => {
  const manager = new RagWorkerManager();
  const worker = {
    pid: 999_997,
    send(_message, callback) {
      callback?.();
      return true;
    },
    kill() {
      return true;
    },
  };
  manager.worker = worker;
  manager.workerState = "running";

  const originalEnabled = ragConfig.enabled;
  const originalUpdateMany = prisma.ragIndexJob.updateMany;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  let spawnCount = 0;
  ragConfig.enabled = true;
  prisma.ragIndexJob.updateMany = async () => ({ count: 1 });
  manager.spawnWorkerIfNeeded = async () => {
    spawnCount += 1;
  };
  global.setTimeout = (callback) => {
    const timer = { callback, unref() {} };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  try {
    const refreshPromise = manager.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(timers.length >= 1);
    ragConfig.enabled = false;
    timers.at(-1).callback();
    manager.handleWorkerExit(worker, { end() {} }, 137, "SIGKILL");
    await refreshPromise;

    assert.equal(manager.worker, null);
    assert.equal(spawnCount, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    prisma.ragIndexJob.updateMany = originalUpdateMany;
    ragConfig.enabled = originalEnabled;
    manager.worker = null;
    await manager.shutdown();
  }
});

test("RAG watchdog kills a stalled worker and requeues running jobs", async () => {
  const manager = new RagWorkerManager();
  const fake = installWorker(manager, {
    lastHeartbeatAt: Date.now() - 3 * 60_000,
    receivedHeartbeat: true,
  });
  const originalUpdateMany = prisma.ragIndexJob.updateMany;
  const originalCount = prisma.ragIndexJob.count;
  const originalSetTimeout = global.setTimeout;
  let updateArgs = null;
  global.setTimeout = () => ({ unref() {} });
  prisma.ragIndexJob.updateMany = async (args) => {
    updateArgs = args;
    return { count: 2 };
  };
  prisma.ragIndexJob.count = async () => 0;

  try {
    manager.checkStalled();
    assert.equal(manager.worker, fake.worker);
    manager.handleWorkerExit(fake.worker, { end() {} }, 137, "SIGKILL");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fake.getKillCount(), 1);
    assert.equal(manager.worker, null);
    assert.deepEqual(updateArgs.where, { status: "running" });
    assert.equal(updateArgs.data.status, "queued");
    assert.equal(updateArgs.data.lastError, "RAG worker stalled; job requeued.");
  } finally {
    global.setTimeout = originalSetTimeout;
    prisma.ragIndexJob.updateMany = originalUpdateMany;
    prisma.ragIndexJob.count = originalCount;
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
