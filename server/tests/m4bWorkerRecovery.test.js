const test = require("node:test");
const assert = require("node:assert/strict");
const { M4bWorkerManager } = require("../dist/services/audiobook/m4b/M4bWorkerManager.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("m4b worker replacement waits for ownership recovery", async () => {
  const manager = new M4bWorkerManager();
  const recovery = deferred();
  let recoveryWorkerId = null;
  manager.queueService = {
    recoverJobsForWorker: async (workerId) => {
      recoveryWorkerId = workerId;
      return recovery.promise;
    },
  };

  const originalSetTimeout = global.setTimeout;
  let scheduled = null;
  global.setTimeout = (callback, delay) => {
    scheduled = { callback, delay };
    return { unref() {} };
  };

  try {
    const replacement = manager.recoverAndReplaceWorker("4821");
    await Promise.resolve();
    assert.equal(recoveryWorkerId, "4821");
    assert.equal(scheduled, null, "replacement must not be scheduled before recovery finishes");

    recovery.resolve({ requeued: 1, failed: 0 });
    await replacement;

    assert.equal(scheduled.delay, 10_000);
    assert.equal(typeof scheduled.callback, "function");
  } finally {
    global.setTimeout = originalSetTimeout;
    await manager.shutdown();
  }
});

test("m4b worker replacement is still scheduled when recovery fails", async () => {
  const manager = new M4bWorkerManager();
  manager.queueService = {
    recoverJobsForWorker: async () => {
      throw new Error("database unavailable");
    },
  };

  const originalSetTimeout = global.setTimeout;
  let scheduled = null;
  global.setTimeout = (callback, delay) => {
    scheduled = { callback, delay };
    return { unref() {} };
  };

  try {
    await manager.recoverAndReplaceWorker("4821");
    assert.equal(scheduled.delay, 10_000);
    assert.equal(typeof scheduled.callback, "function");
  } finally {
    global.setTimeout = originalSetTimeout;
    await manager.shutdown();
  }
});
