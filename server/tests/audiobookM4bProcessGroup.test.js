const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { encodeFullBookM4b } = require("../dist/services/audiobook/audiobookM4b.js");
const {
  runFfmpegProcess,
} = require("../dist/services/audiobook/infrastructure/m4b/FfmpegProcessRunner.js");

function makeTaskDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-process-group-task-"));
}

function installWrapperWithLongLivedDescendant() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-process-group-wrapper-"));
  const writer = path.join(root, "writer.js");
  const wrapper = path.join(root, "ffmpeg-wrapper.sh");
  const heartbeat = path.join(root, "descendant-heartbeat");
  const descendantPid = path.join(root, "descendant.pid");
  const started = path.join(root, "started");
  fs.writeFileSync(writer, [
    'const fs = require("node:fs");',
    'const target = process.argv[2];',
    'const tick = () => fs.appendFileSync(target, "x");',
    "tick();",
    "setInterval(tick, 25);",
    "",
  ].join("\n"));
  fs.writeFileSync(wrapper, [
    "#!/bin/sh",
    `node "${writer}" "${heartbeat}" &`,
    'descendant="$!"',
    `printf "%s" "$descendant" > "${descendantPid}"`,
    `touch "${started}"`,
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o755 });
  return { root, wrapper, heartbeat, descendantPid, started };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

test("aborting an ffmpeg wrapper terminates its long-lived descendant", {
  concurrency: false,
  skip: process.platform === "win32" ? "POSIX process-group behavior" : false,
}, async () => {
  const fake = installWrapperWithLongLivedDescendant();
  const taskDir = makeTaskDir();
  const sourceWavPath = path.join(taskDir, "source.wav");
  fs.writeFileSync(sourceWavPath, Buffer.alloc(64));
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.wrapper;
  const controller = new AbortController();
  let pid = null;

  try {
    const pending = encodeFullBookM4b({
      taskDir,
      bookTitle: "wrapper descendant regression",
      sourceWavPath,
      chapters: [],
      signal: controller.signal,
      stallTimeoutMs: 5_000,
    });
    assert.equal(
      await waitFor(() => fs.existsSync(fake.started) && fs.existsSync(fake.heartbeat)),
      true,
      "wrapper and descendant must start before cancellation",
    );
    pid = Number(fs.readFileSync(fake.descendantPid, "utf8"));
    assert.equal(Number.isInteger(pid) && pid > 1, true);

    controller.abort();
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /取消/);

    const before = fs.statSync(fake.heartbeat).size;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = fs.statSync(fake.heartbeat).size;
    assert.equal(
      await waitFor(() => !isProcessAlive(pid), 1_000),
      true,
      "the wrapper descendant must be reaped with its process group",
    );
    assert.equal(after, before, "a cancelled descendant must stop writing after encode returns");
  } finally {
    if (pid && isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test("a stalled ffmpeg wrapper is killed together with its long-lived descendant", {
  concurrency: false,
  skip: process.platform === "win32" ? "POSIX process-group behavior" : false,
}, async () => {
  const fake = installWrapperWithLongLivedDescendant();
  const taskDir = makeTaskDir();
  const sourceWavPath = path.join(taskDir, "source.wav");
  fs.writeFileSync(sourceWavPath, Buffer.alloc(64));
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.wrapper;
  let pid = null;

  try {
    const result = await encodeFullBookM4b({
      taskDir,
      bookTitle: "stalled wrapper descendant regression",
      sourceWavPath,
      chapters: [],
      // Test files run in parallel worker processes by default. Give the shell
      // enough time to be scheduled and create its descendant before asserting
      // process-group cleanup; production uses a five-minute stall window.
      stallTimeoutMs: 2_000,
    });
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /停滞/);
    assert.equal(fs.existsSync(fake.descendantPid), true);
    pid = Number(fs.readFileSync(fake.descendantPid, "utf8"));

    const before = fs.statSync(fake.heartbeat).size;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = fs.statSync(fake.heartbeat).size;
    assert.equal(await waitFor(() => !isProcessAlive(pid), 1_000), true);
    assert.equal(after, before, "a stalled descendant must stop writing after encode returns");
  } finally {
    if (pid && isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test("an abort racing listener registration still cancels the spawned ffmpeg process", {
  concurrency: false,
  skip: process.platform === "win32" ? "POSIX shell fixture" : false,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-abort-race-"));
  const wrapper = path.join(root, "ffmpeg-wrapper.sh");
  fs.writeFileSync(wrapper, [
    "#!/bin/sh",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o755 });

  let abortedReadCount = 0;
  const signal = {
    get aborted() {
      abortedReadCount += 1;
      return abortedReadCount >= 2;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    await assert.rejects(
      runFfmpegProcess({
        ffmpeg: wrapper,
        args: [],
        signal,
        stallTimeoutMs: 50,
      }),
      /取消/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
