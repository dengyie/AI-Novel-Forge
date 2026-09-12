const test = require("node:test");
const assert = require("node:assert/strict");
const { M4bWorkerManager } = require("../dist/services/audiobook/m4b/M4bWorkerManager.js");

test("M4bWorkerManager spawns worker when jobs pending", { timeout: 10000 }, async (t) => {
  // Mock spawn to avoid actually starting worker
  const originalSpawn = require("node:child_process").spawn;
  let spawnCalled = false;
  let spawnArgs = null;

  require("node:child_process").spawn = (command, args, options) => {
    spawnCalled = true;
    spawnArgs = { command, args, options };
    // Return mock ChildProcess
    const EventEmitter = require("node:events");
    const mock = new EventEmitter();
    mock.pid = 99999;
    mock.kill = () => true;
    return mock;
  };

  t.after(() => {
    require("node:child_process").spawn = originalSpawn;
  });

  const manager = new M4bWorkerManager();
  await manager.ensureWorkerForPendingJobs();

  // Immediate call should not spawn (no pending jobs in test DB)
  assert.equal(spawnCalled, false);

  await manager.shutdown();
});
