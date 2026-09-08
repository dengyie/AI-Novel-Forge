/**
 * m4b 并发互斥（withTaskDirLock）回归测试。
 *
 * 背景：pause/restart/后台队列等多个入口可能对同一 taskDir 并发请求 encodeFullBookM4b。
 * 若无串行化，每个入口会各自 spawn 一个 ffmpeg 重读整部 WAV，成倍放大共享宿主的
 * CPU/内存/磁盘占用（线上曾观察到同书多 ffmpeg 并发、宿主 OOM 牵连 novel-server）。
 *
 * 覆盖：
 *  (a) 同一 taskDir 并发两次 encode → 底层 ffmpeg 只 spawn 一次（串行化生效）；
 *  (b) 两次结果都 ready，产物复用同一份规范名，无重复编码；
 *  (c) 不同 taskDir 的 encode 互不阻塞（仍可并发）。
 *
 * 用假 ffmpeg（AUDIOBOOK_FFMPEG_PATH 指向 shell 脚本）：每次被调都向计数文件
 * append 一行，并把源文件复制到产物路径。由此断言底层 spawn 次数。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildM4bFfmpegArgs,
  encodeFullBookM4b,
} = require("../dist/services/audiobook/audiobookM4b.js");
const { resolveFullBookM4bPath } = require("../dist/services/audiobook/audiobookPaths.js");

function makeTaskDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ab-m4b-lock-${label}-`));
}

/** 生成假 ffmpeg：append 计数到 $COUNT_FILE，源复制到产物路径。 */
function installFakeFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-lock-ffmpeg-"));
  const countFile = path.join(dir, "calls.log");
  const script = path.join(dir, "fake-ffmpeg.sh");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `echo "call" >> "${countFile}"`,
      'prev=""',
      'src=""',
      'last=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-i" ] && [ -z "$src" ]; then src="$a"; fi',
      '  last="$a"',
      '  prev="$a"',
      "done",
      'cp "$src" "$last"',
      'sleep 0.3',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { script, countFile };
}

function installPermitHandoffFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-permit-handoff-"));
  const script = path.join(dir, "fake-ffmpeg.sh");
  const firstStarted = path.join(dir, "first-started");
  const releaseFirst = path.join(dir, "release-first");
  const calls = path.join(dir, "calls");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `if [ ! -f "${calls}" ]; then`,
      `  printf "x" > "${calls}"`,
      `  touch "${firstStarted}"`,
      `  while [ ! -f "${releaseFirst}" ]; do sleep 0.02; done`,
      "else",
      `  printf "x" >> "${calls}"`,
      "fi",
      'prev=""',
      'src=""',
      'last=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-i" ] && [ -z "$src" ]; then src="$a"; fi',
      '  last="$a"',
      '  prev="$a"',
      "done",
      'cp "$src" "$last"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { dir, script, firstStarted, releaseFirst, calls };
}

const { script: FFMPEG_SCRIPT, countFile: COUNT_FILE } = installFakeFfmpeg();
const OLD_FFMPEG_PATH = process.env.AUDIOBOOK_FFMPEG_PATH;

test.before(() => {
  process.env.AUDIOBOOK_FFMPEG_PATH = FFMPEG_SCRIPT;
});
test.after(() => {
  if (OLD_FFMPEG_PATH === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
  else process.env.AUDIOBOOK_FFMPEG_PATH = OLD_FFMPEG_PATH;
});

test("ffmpeg thread cap is applied to the AAC output rather than an input decoder", () => {
  const args = buildM4bFfmpegArgs({
    sourceWavPath: "/tmp/source.wav",
    metadataPath: "/tmp/chapters.ffmeta",
    outputPath: "/tmp/full-book.m4b.part",
    threads: 2,
  });

  const lastInputIndex = args.lastIndexOf("-i");
  const codecIndex = args.indexOf("-c:a");
  const threadsIndex = args.indexOf("-threads");
  assert.ok(threadsIndex > lastInputIndex, "-threads must not be parsed as an input option");
  assert.ok(threadsIndex > codecIndex, "-threads must sit in the output codec option region");
});

function writeMarkerFile(p, ch, len) {
  fs.writeFileSync(p, ch.repeat(len));
}

function callCount() {
  if (!fs.existsSync(COUNT_FILE)) return 0;
  return fs.readFileSync(COUNT_FILE, "utf8").split("\n").filter((l) => l === "call").length;
}

// ── (a) 同 taskDir 并发 → 底层只 spawn 一次 ──

test("同一 taskDir 并发两次 encode 只 spawn 一次 ffmpeg（串行化生效）", async () => {
  const taskDir = makeTaskDir("serial");
  const src = path.join(taskDir, "src.wav");
  writeMarkerFile(src, "S", 8192);
  const before = callCount();

  const [r1, r2] = await Promise.all([
    encodeFullBookM4b({ taskDir, bookTitle: "串行 A", sourceWavPath: src, chapters: [] }),
    encodeFullBookM4b({ taskDir, bookTitle: "串行 B", sourceWavPath: src, chapters: [] }),
  ]);

  assert.equal(r1.status, "ready", `run1 failed: ${r1.reason}`);
  assert.equal(r2.status, "ready", `run2 failed: ${r2.reason}`);
  assert.equal(callCount() - before, 1, "同 taskDir 并发必须只触发一次底层 ffmpeg spawn");

  const canonical = resolveFullBookM4bPath(taskDir);
  assert.equal(fs.existsSync(canonical), true, "规范名存在");
  assert.equal(fs.readFileSync(canonical, "utf8"), "S".repeat(8192), "产物内容完整");
});

// ── (c) 不同 taskDir 仍可并发（不误伤吞吐）──

test("不同 taskDir 的 encode 互不阻塞", async () => {
  const dirA = makeTaskDir("parA");
  const dirB = makeTaskDir("parB");
  const srcA = path.join(dirA, "src.wav");
  const srcB = path.join(dirB, "src.wav");
  writeMarkerFile(srcA, "A", 4096);
  writeMarkerFile(srcB, "B", 4096);
  const before = callCount();

  const [ra, rb] = await Promise.all([
    encodeFullBookM4b({ taskDir: dirA, bookTitle: "并行 A", sourceWavPath: srcA, chapters: [] }),
    encodeFullBookM4b({ taskDir: dirB, bookTitle: "并行 B", sourceWavPath: srcB, chapters: [] }),
  ]);

  assert.equal(ra.status, "ready", ra.reason);
  assert.equal(rb.status, "ready", rb.reason);
  assert.equal(callCount() - before, 2, "不同 taskDir 应各自 spawn（互不阻塞）");
  assert.equal(fs.readFileSync(resolveFullBookM4bPath(dirA), "utf8"), "A".repeat(4096));
  assert.equal(fs.readFileSync(resolveFullBookM4bPath(dirB), "utf8"), "B".repeat(4096));
});

// ── (d) 三个以上并发请求同 taskDir → 仍只 spawn 一次（递归锁生效）──

test("同一 taskDir 三次并发也只 spawn 一次 ffmpeg（递归锁）", async () => {
  const taskDir = makeTaskDir("triple");
  const src = path.join(taskDir, "src.wav");
  writeMarkerFile(src, "T", 4096);
  const before = callCount();

  const results = await Promise.all([
    encodeFullBookM4b({ taskDir, bookTitle: "三并发 1", sourceWavPath: src, chapters: [] }),
    encodeFullBookM4b({ taskDir, bookTitle: "三并发 2", sourceWavPath: src, chapters: [] }),
    encodeFullBookM4b({ taskDir, bookTitle: "三并发 3", sourceWavPath: src, chapters: [] }),
  ]);

  for (const r of results) {
    assert.equal(r.status, "ready", r.reason);
  }
  assert.equal(callCount() - before, 1, "相同 taskDir 三次并发必须只触发一次底层 ffmpeg spawn");
  assert.equal(fs.readFileSync(resolveFullBookM4bPath(taskDir), "utf8"), "T".repeat(4096));
});

test("taskDir lock 的等待者 abort 后应立即退出且不阻塞后续等待者", async () => {
  const taskDir = makeTaskDir("cancel-waiter");
  const src = path.join(taskDir, "src.wav");
  writeMarkerFile(src, "W", 8192);
  const first = encodeFullBookM4b({ taskDir, bookTitle: "持有锁", sourceWavPath: src, chapters: [] });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const controller = new AbortController();
  const waiting = encodeFullBookM4b({
    taskDir,
    bookTitle: "取消等待",
    sourceWavPath: src,
    chapters: [],
    signal: controller.signal,
  });
  controller.abort();
  const waitingResult = await Promise.race([
    waiting,
    new Promise((_, reject) => setTimeout(() => reject(new Error("lock waiter timeout")), 100)),
  ]);
  assert.equal(waitingResult.status, "failed");
  assert.match(waitingResult.reason ?? "", /取消|abort/i);
  const firstResult = await first;
  assert.equal(firstResult.status, "ready", firstResult.reason);
});

test("全局许可交给已取消等待者时会继续唤醒下一项", { concurrency: false }, async () => {
  const fake = installPermitHandoffFfmpeg();
  const dirs = [
    makeTaskDir("permit-holder"),
    makeTaskDir("permit-cancelled"),
    makeTaskDir("permit-successor"),
  ];
  const sources = dirs.map((dir, index) => {
    const source = path.join(dir, "src.wav");
    writeMarkerFile(source, String(index + 1), 4096);
    return source;
  });
  const cancelled = new AbortController();
  const successor = new AbortController();
  const originalRemoveEventListener = cancelled.signal.removeEventListener;
  let abortOnHandoff = true;
  cancelled.signal.removeEventListener = function removeAndAbort(type, listener, options) {
    const result = originalRemoveEventListener.call(this, type, listener, options);
    if (type === "abort" && abortOnHandoff) {
      abortOnHandoff = false;
      cancelled.abort();
    }
    return result;
  };
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.script;
  let holder;
  let cancelledWaiter;
  let successorWaiter;
  try {
    holder = encodeFullBookM4b({
      taskDir: dirs[0],
      bookTitle: "许可持有者",
      sourceWavPath: sources[0],
      chapters: [],
    });
    const startDeadline = Date.now() + 2_000;
    while (!fs.existsSync(fake.firstStarted) && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(fake.firstStarted), true);

    cancelledWaiter = encodeFullBookM4b({
      taskDir: dirs[1],
      bookTitle: "交接时取消",
      sourceWavPath: sources[1],
      chapters: [],
      signal: cancelled.signal,
    });
    successorWaiter = encodeFullBookM4b({
      taskDir: dirs[2],
      bookTitle: "后继任务",
      sourceWavPath: sources[2],
      chapters: [],
      signal: successor.signal,
    });
    fs.writeFileSync(fake.releaseFirst, "go");

    const [holderResult, cancelledResult, successorResult] = await Promise.race([
      Promise.all([holder, cancelledWaiter, successorWaiter]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("successor global permit waiter timed out")),
        1_500,
      )),
    ]);
    assert.equal(holderResult.status, "ready", holderResult.reason);
    assert.equal(cancelledResult.status, "failed");
    assert.match(cancelledResult.reason ?? "", /取消/);
    assert.equal(successorResult.status, "ready", successorResult.reason);
    assert.equal(fs.readFileSync(fake.calls, "utf8").length, 2, "已取消等待者不得 spawn ffmpeg");
  } finally {
    successor.abort();
    await Promise.allSettled([holder, cancelledWaiter, successorWaiter].filter(Boolean));
    process.env.AUDIOBOOK_FFMPEG_PATH = FFMPEG_SCRIPT;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});
