const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");

const originalExecFile = childProcess.execFile;
const originalKill = process.kill;
const originalPlatform = process.platform;
const originalNow = Date.now;
const originalWarn = console.warn;
const { killOrphanM4bFfmpeg } = require("../dist/services/audiobook/AudiobookTaskService.js");

function stubPs(stdout) {
  childProcess.execFile = (_command, _args, _options, callback) => {
    setImmediate(() => callback(null, stdout, ""));
    return undefined;
  };
}

test.afterEach(() => {
  childProcess.execFile = originalExecFile;
  process.kill = originalKill;
  Object.defineProperty(process, "platform", { value: originalPlatform });
  Date.now = originalNow;
  console.warn = originalWarn;
});

test("orphan m4b cleanup waits until SIGKILL target exits", async () => {
  const pid = 424242;
  const signalTarget = process.platform === "win32" ? pid : -pid;
  let alive = true;
  const killCalls = [];
  stubPs(` ${pid} 1 /usr/bin/ffmpeg -i src.wav /tmp/orphan-m4b-wait/full-book.m4b.run.part\n`);
  process.kill = (target, signal) => {
    assert.equal(target, signalTarget);
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

test("Windows recovery skips the unavailable POSIX process scan", { concurrency: false }, async () => {
  let execCalls = 0;
  Object.defineProperty(process, "platform", { value: "win32" });
  childProcess.execFile = (_command, _args, _options, callback) => {
    execCalls += 1;
    setImmediate(() => callback(new Error("spawn ps ENOENT"), "", ""));
    return undefined;
  };

  const cleaned = await killOrphanM4bFfmpeg("C:\\audiobook\\task-1");

  assert.equal(cleaned, true, "unsupported orphan inspection must not block database recovery");
  assert.equal(execCalls, 0, "Windows recovery must not attempt to spawn POSIX ps");
});

test("orphan m4b cleanup logs remaining PIDs when exit wait times out", async () => {
  const pid = 434343;
  const signalTarget = process.platform === "win32" ? pid : -pid;
  const warnings = [];
  let now = 0;
  stubPs(` ${pid} 1 /usr/bin/ffmpeg -i src.wav /tmp/orphan-m4b-timeout/full-book.m4b.run.part\n`);
  console.warn = (...args) => warnings.push(args);
  Date.now = () => now;
  process.kill = (target, signal) => {
    assert.equal(target, signalTarget);
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

test("orphan cleanup falls back to a direct PID for a legacy non-group ffmpeg", {
  skip: process.platform === "win32" ? "POSIX legacy group fallback" : false,
}, async () => {
  const pid = 454545;
  const calls = [];
  let alive = true;
  stubPs(` ${pid} 1 /usr/bin/ffmpeg -i src.wav /tmp/orphan-m4b-legacy/full-book.m4b.run.part\n`);
  process.kill = (target, signal) => {
    calls.push([target, signal]);
    if (target === -pid && signal === "SIGKILL") {
      const error = new Error("not a process-group leader");
      error.code = "ESRCH";
      throw error;
    }
    assert.equal(target, pid);
    if (signal === "SIGKILL") {
      alive = false;
      return true;
    }
    if (signal === 0 && alive) return true;
    const error = new Error("process exited");
    error.code = "ESRCH";
    throw error;
  };

  assert.equal(await killOrphanM4bFfmpeg("/tmp/orphan-m4b-legacy"), true);
  assert.deepEqual(calls.slice(0, 2), [
    [-pid, "SIGKILL"],
    [pid, "SIGKILL"],
  ]);
});

test("a reused PID from a shared recovery snapshot is revalidated before SIGKILL", async () => {
  const pid = 444444;
  const taskDir = "/tmp/orphan-m4b-stale-snapshot";
  const staleSnapshot = ` ${pid} 1 /usr/bin/ffmpeg -i src.wav ${taskDir}/full-book.m4b.run.part\n`;
  const killCalls = [];
  // By the time this row is processed, the old ffmpeg is gone and the PID now
  // belongs to an unrelated orphan. Recovery must not trust the shared snapshot
  // strongly enough to kill the new process.
  stubPs(` ${pid} 1 /usr/bin/sleep 999\n`);
  process.kill = (target, signal) => {
    killCalls.push([target, signal]);
    return true;
  };

  const cleaned = await killOrphanM4bFfmpeg(taskDir, staleSnapshot);

  assert.equal(cleaned, true);
  assert.equal(
    killCalls.some(([, signal]) => signal === "SIGKILL"),
    false,
    "stale snapshot data must never authorize SIGKILL of a reused PID",
  );
});
