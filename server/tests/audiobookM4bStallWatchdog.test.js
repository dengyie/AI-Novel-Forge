// Timing fixtures must not be deliberately deprioritized against the parallel test runner.
process.env.AUDIOBOOK_M4B_FFMPEG_NICE = "0";
/**
 * m4b 编码「停滞看门狗」回归测试（根因修复 2026-09-03）。
 *
 * 生产实证：2GB WAV + 降权(nice 10) + 限 2 线程时，全量重编码需要 ~37 分钟，
 * 旧「绝对墙钟超时 40min」模型会在推进中的编码即将完成时误杀它，之后每次
 * 重试都被掐在同一位置，只能全量重跑——这正是「m4b 反复失败收不了尾」的根因之一。
 *
 * 新模型：不看墙钟，只看 `.part` 是否仍在增长。
 *  - 只要产物在涨 → 绝不因「慢」被 kill（本测试用「极慢但持续推进」的假 ffmpeg 证明）；
 *  - 产物连续停滞超过 stallTimeoutMs → 判真挂 kill（本测试用「写一字节后永久停滞」证明）。
 *
 * 用真实 shell 夹具（AUDIOBOOK_FFMPEG_PATH）避免依赖真实编码。
 * 启动和实际文件增长通过 ready/ack 确认后，再推进测试父进程的虚拟时钟；
 * 子进程调度耗时不会消耗被测停滞窗口，取消和进程组回收仍使用真实进程。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { encodeFullBookM4b } = require("../dist/services/audiobook/audiobookM4b.js");

function makeTaskDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ab-stall-${label}-`));
}

// Wall-clock time is only for real fixture startup/I/O. Watchdog time is virtual.
const realSetTimeout = setTimeout;
const { performance } = require("node:perf_hooks");
const FIXTURE_STARTUP_BUDGET_MS = 15_000;
async function waitForFixture(predicate, description) {
  const deadline = performance.now() + FIXTURE_STARTUP_BUDGET_MS;
  while (!predicate() && performance.now() < deadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, description);
}

function installControlledFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-controlled-ffmpeg-"));
  const script = path.join(dir, "controlled.sh");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    'for out in "$@"; do :; done',
    `touch "${dir}/ready"`,
    "index=1",
    "while :; do",
    `  if [ -f "${dir}/grow-$index" ]; then`,
    '    printf "%064d" 0 >> "$out"',
    `    touch "${dir}/ack-$index"`,
    "    index=$((index + 1))",
    "  fi",
    `  if [ -f "${dir}/finish" ]; then exit 0; fi`,
    "  sleep 0.01",
    "done", "",
  ].join("\n"), { mode: 0o755 });
  return { dir, script };
}

async function withControlledEncoder(t, stallTimeoutMs, run) {
  const fake = installControlledFfmpeg();
  const taskDir = makeTaskDir("controlled");
  const src = path.join(taskDir, "src.wav");
  writeSrcWav(src);
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.script;
  const controller = new AbortController();
  let pending;
  let growth = 0;
  let progressSamples = 0;
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  try {
    pending = encodeFullBookM4b({ taskDir, bookTitle: "controlled test", sourceWavPath: src,
      chapters: [], signal: controller.signal, stallTimeoutMs,
      onProgress: () => { progressSamples++; },
    });
    await waitForFixture(() => fs.existsSync(path.join(fake.dir, "ready")), "actual fake encoder must report ready");
    await run({
      tick: (ms) => t.mock.timers.tick(ms),
      grow: async () => {
        const index = ++growth;
        fs.writeFileSync(path.join(fake.dir, `grow-${index}`), "go");
        await waitForFixture(() => fs.existsSync(path.join(fake.dir, `ack-${index}`)), "encoder must acknowledge actual output growth");
      },
      samples: () => progressSamples,
      finish: () => fs.writeFileSync(path.join(fake.dir, "finish"), "go"),
      result: () => pending,
    });
  } finally {
    controller.abort();
    fs.writeFileSync(path.join(fake.dir, "finish"), "go");
    t.mock.timers.reset();
    await pending;
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
}

/**
 * Cancellation fixture whose inherited stderr pipe stays open briefly after the
 * shell receives SIGKILL. ChildProcess emits `close` only after that pipe closes,
 * giving a deterministic signal that the encoder lifecycle has really ended.
 */
function installDelayedCloseFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-stall-ffmpeg-"));
  const script = path.join(dir, "delayed-close.js");
  const holder = path.join(dir, "stderr-holder.js");
  const started = path.join(dir, "started");
  const holderReady = path.join(dir, "holder-ready");
  const release = path.join(dir, "release-holder");
  fs.writeFileSync(
    holder,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(holderReady)}, 'ready');`,
      `const release = ${JSON.stringify(release)};`,
      "const timer = setInterval(() => {",
      "  if (fs.existsSync(release)) { clearInterval(timer); process.exit(0); }",
      "}, 10);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    script,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
      // Keep stderr open from a separate process group. The runner kills the
      // ffmpeg group, while this detached holder keeps ChildProcess `close`
      // delayed long enough to verify that cancellation waits for stream close.
      `spawn(process.execPath, [${JSON.stringify(holder)}], { detached: true, stdio: ['ignore', 'ignore', process.stderr] }).unref();`,
      "setInterval(() => {}, 50);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { script, started, holderReady, release };
}

function installKillReleaseRaceFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-stall-ffmpeg-race-"));
  const script = path.join(dir, "kill-release-race.sh");
  const firstStarted = path.join(dir, "first-started");
  const secondStarted = path.join(dir, "second-started");
  const firstDescendantPid = path.join(dir, "first-descendant.pid");
  const overlap = path.join(dir, "overlap");
  const callCounter = path.join(dir, "call-counter");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `if [ ! -f "${callCounter}" ]; then`,
      `  touch "${callCounter}" "${firstStarted}"`,
      "  ( sleep 1.5 ) &",
      `  printf "%s" "$!" > "${firstDescendantPid}"`,
      "  while :; do sleep 0.05; done",
      "fi",
      'last=""',
      'for a in "$@"; do last="$a"; done',
      `if kill -0 "$(cat "${firstDescendantPid}")" 2>/dev/null; then touch "${overlap}"; fi`,
      `touch "${secondStarted}"`,
      'printf "%064d" 0 > "$last"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { script, firstStarted, secondStarted, overlap };
}

function writeSrcWav(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(64)); // 假源文件，内容无所谓
}

test("慢但持续推进的编码不会因绝对时长被误杀（stall 看门狗按增长续命）", async (t) => {
  await withControlledEncoder(t, 1000, async (encoder) => {
    for (let i = 0; i < 5; i++) { await encoder.grow(); encoder.tick(900); }
    encoder.finish();
    const result = await encoder.result();
    assert.equal(result.status, "ready", result.reason);
  });
});

test("进度采样更新字节后，旧 watchdog deadline 不应误杀仍在推进的编码", async (t) => {
  await withControlledEncoder(t, 12000, async (encoder) => {
    await encoder.grow(); encoder.tick(9000);
    await encoder.grow(); encoder.tick(1000);
    assert.ok(encoder.samples() > 0, "progress sampling must precede the watchdog deadline");
    encoder.tick(2000);
    encoder.finish();
    const result = await encoder.result();
    assert.equal(result.status, "ready", result.reason);
  });
});

test("首字节未产生超过 stall 窗口 → 看门狗判死并回收 ffmpeg", async (t) => {
  await withControlledEncoder(t, 1000, async (encoder) => {
    encoder.tick(1000);
    const result = await encoder.result();
    assert.equal(result.status, "failed"); assert.match(result.reason, /停滞/);
  });
});

test("产物连续停滞超过 stall 窗口 → 看门狗判死并报错", async (t) => {
  await withControlledEncoder(t, 1000, async (encoder) => {
    await encoder.grow(); encoder.tick(1000); encoder.tick(1000);
    const result = await encoder.result();
    assert.equal(result.status, "failed"); assert.match(result.reason, /停滞/);
  });
});

test("取消编码后等待 ffmpeg close 再释放调用方", async () => {
  const fake = installDelayedCloseFfmpeg();
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.script;
  const taskDir = makeTaskDir("cancel-close");
  const src = path.join(taskDir, "src.wav");
  writeSrcWav(src);
  const controller = new AbortController();

  let pending;
  try {
    pending = encodeFullBookM4b({
      taskDir,
      bookTitle: "取消等待书",
      sourceWavPath: src,
      chapters: [],
      signal: controller.signal,
      stallTimeoutMs: FIXTURE_STARTUP_BUDGET_MS * 2,
    });
    await waitForFixture(() => fs.existsSync(fake.started) && fs.existsSync(fake.holderReady),
      "encoder and stderr holder must both report ready before cancellation");
    assert.equal(fs.existsSync(fake.started), true, "fake ffmpeg should have started");
    assert.equal(fs.existsSync(fake.holderReady), true, "stderr holder should have started");
    controller.abort();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "encode promise must wait for the inherited stderr holder to close");
    fs.writeFileSync(fake.release, "release");
    const result = await pending;

    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /取消/);
  } finally {
    controller.abort();
    fs.writeFileSync(fake.release, "release");
    await pending;
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
  }
});

test("被取消的 ffmpeg 子孙进程退出前不得与下一个 m4b 编码重叠", async () => {
  const fake = installKillReleaseRaceFfmpeg();
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.script;
  const firstDir = makeTaskDir("kill-release-first");
  const secondDir = makeTaskDir("kill-release-second");
  const firstSrc = path.join(firstDir, "src.wav");
  const secondSrc = path.join(secondDir, "src.wav");
  writeSrcWav(firstSrc);
  writeSrcWav(secondSrc);
  const controller = new AbortController();

  let first;
  let second;
  const secondController = new AbortController();
  try {
    first = encodeFullBookM4b({
      taskDir: firstDir,
      bookTitle: "被取消",
      sourceWavPath: firstSrc,
      chapters: [],
      signal: controller.signal,
      stallTimeoutMs: FIXTURE_STARTUP_BUDGET_MS * 2,
    });
    await waitForFixture(() => fs.existsSync(fake.firstStarted), "first encoder must report ready");
    assert.equal(fs.existsSync(fake.firstStarted), true, "first fake ffmpeg should have started");

    controller.abort();
    second = encodeFullBookM4b({
      signal: secondController.signal,
      taskDir: secondDir,
      bookTitle: "后继任务",
      sourceWavPath: secondSrc,
      chapters: [],
      stallTimeoutMs: FIXTURE_STARTUP_BUDGET_MS * 2,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, "failed");
    assert.equal(secondResult.status, "ready", secondResult.reason);
    assert.equal(fs.existsSync(fake.secondStarted), true);
    assert.equal(
      fs.existsSync(fake.overlap),
      false,
      "the global permit must not be released while an old encoder descendant is alive",
    );
  } finally {
    controller.abort();
    secondController.abort();
    await Promise.allSettled([first, second].filter(Boolean));
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
  }
});
