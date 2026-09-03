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

const { encodeFullBookM4b } = require("../dist/services/audiobook/audiobookM4b.js");
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

const { script: FFMPEG_SCRIPT, countFile: COUNT_FILE } = installFakeFfmpeg();
const OLD_FFMPEG_PATH = process.env.AUDIOBOOK_FFMPEG_PATH;

test.before(() => {
  process.env.AUDIOBOOK_FFMPEG_PATH = FFMPEG_SCRIPT;
});
test.after(() => {
  if (OLD_FFMPEG_PATH === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
  else process.env.AUDIOBOOK_FFMPEG_PATH = OLD_FFMPEG_PATH;
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
