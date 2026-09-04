const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");

const originalExecFile = childProcess.execFile;
const originalKill = process.kill;
const originalNow = Date.now;
const originalWarn = console.warn;
const { killOrphanM4bFfmpeg } = require("../dist/services/audiobook/AudiobookTaskService.js");

function stubPgrep(stdout) {
  childProcess.execFile = (_command, _args, _options, callback) => {
    setImmediate(() => callback(null, stdout, ""));
    return undefined;
  };
}

test.afterEach(() => {
  childProcess.execFile = originalExecFile;
  process.kill = originalKill;
  Date.now = originalNow;
  console.warn = originalWarn;
});

test("orphan m4b cleanup waits until SIGKILL target exits", async () => {
  const pid = 424242;
  let alive = true;
  const killCalls = [];
  stubPgrep(`${pid}\n`);
  process.kill = (target, signal) => {
    assert.equal(target, pid);
    killCalls.push(signal);
    if (signal === "SIGKILL") {
      setTimeout(() => {
        alive = false;
      }, 80);
      return true;
    }
    if (signal === 0 && alive) return true;
    const error = new Error("process exited");
    error.code = "ESRCH";
    throw error;
  };

  const startedAt = originalNow();
  await killOrphanM4bFfmpeg("/tmp/orphan-m4b-wait");

  assert.deepEqual(killCalls[0], "SIGKILL");
  assert.ok(
    originalNow() - startedAt >= 70,
    "cleanup must not resolve immediately after sending SIGKILL",
  );
  assert.ok(killCalls.includes(0), "cleanup must probe for process exit");
});

test("orphan m4b cleanup logs remaining PIDs when exit wait times out", async () => {
  const pid = 434343;
  const warnings = [];
  let now = 0;
  stubPgrep(`${pid}\n`);
  console.warn = (...args) => warnings.push(args);
  Date.now = () => now;
  process.kill = (target, signal) => {
    assert.equal(target, pid);
    if (signal === 0) now = 2_000;
    return true;
  };

  await killOrphanM4bFfmpeg("/tmp/orphan-m4b-timeout");

  const timeoutWarning = warnings.find(
    (args) => args[0] === "[audiobook] 孤儿 ffmpeg 退出等待超时",
  );
  assert.ok(timeoutWarning, "timeout must be visible in logs");
  assert.deepEqual(timeoutWarning[1], {
    taskDir: "/tmp/orphan-m4b-timeout",
    timeoutMs: 2_000,
    pids: [pid],
  });
});
