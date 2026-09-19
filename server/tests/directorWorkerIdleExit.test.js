const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DirectorWorkerManager } = require("../dist/runtime/DirectorWorkerManager.js");

const serverRoot = path.resolve(__dirname, "..");
const workerScript = path.join(serverRoot, "dist", "workers", "directorWorker.js");

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`director worker did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("idle director child disconnects and exits after its worker loop drains", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-novel-director-idle-"));
  const databasePath = path.join(tempDir, "idle-worker.db");
  const child = spawn(process.execPath, [workerScript], {
    cwd: serverRoot,
    env: {
      ...process.env,
      AI_NOVEL_SKIP_RUNTIME_MIGRATIONS: "1",
      DATABASE_URL: `file:${databasePath}`,
      DIRECTOR_WORKER_EXECUTION_SLOTS: "1",
      DIRECTOR_WORKER_IDLE_EXIT_MS: "50",
      DIRECTOR_WORKER_POLL_MS: "10",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });

  const result = await waitForExit(child, 2_000);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
});

function createFakeDirectorWorker() {
  const worker = new EventEmitter();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.send = () => true;
  worker.kill = () => true;
  return worker;
}

function createFakeLogStream() {
  return {
    ended: false,
    endCalls: 0,
    chunks: [],
    write(chunk) {
      this.chunks.push(Buffer.from(chunk).toString());
    },
    end() {
      this.ended = true;
      this.endCalls += 1;
    },
  };
}

test("director worker log waits for exit stdio close and keeps the final bytes", async () => {
  const manager = new DirectorWorkerManager();
  const worker = createFakeDirectorWorker();
  const logStream = createFakeLogStream();
  const originalFork = childProcess.fork;
  const originalCreateWriteStream = fs.createWriteStream;
  childProcess.fork = () => worker;
  fs.createWriteStream = () => logStream;

  try {
    manager.kick();
    await new Promise((resolve) => setImmediate(resolve));

    worker.emit("exit", 0, null);
    assert.equal(logStream.endCalls, 0);

    worker.stdout.emit("data", Buffer.from("late stdout\n"));
    worker.stderr.emit("data", Buffer.from("late stderr\n"));
    assert.deepEqual(logStream.chunks, ["late stdout\n", "late stderr\n"]);

    worker.stdout.emit("close");
    assert.equal(logStream.endCalls, 0);
    worker.stderr.emit("close");
    assert.equal(logStream.endCalls, 0);
    worker.emit("close");
    assert.equal(logStream.endCalls, 1);
  } finally {
    childProcess.fork = originalFork;
    fs.createWriteStream = originalCreateWriteStream;
  }
});

test("director worker log uses a bounded fallback for workers without close events", async () => {
  const manager = new DirectorWorkerManager();
  const worker = createFakeDirectorWorker();
  const logStream = createFakeLogStream();
  const originalFork = childProcess.fork;
  const originalCreateWriteStream = fs.createWriteStream;
  const originalSetTimeout = global.setTimeout;
  const timers = [];
  childProcess.fork = () => worker;
  fs.createWriteStream = () => logStream;
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };

  try {
    manager.kick();
    await new Promise((resolve) => setImmediate(resolve));

    worker.emit("exit", 0, null);
    assert.equal(logStream.endCalls, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 1_000);

    timers[0].callback();
    assert.equal(logStream.endCalls, 1);
  } finally {
    childProcess.fork = originalFork;
    fs.createWriteStream = originalCreateWriteStream;
    global.setTimeout = originalSetTimeout;
  }
});
