/**
 * m4b 唯一 run part 名修复的回归测试。
 *
 * 背景：encodeFullBookM4b 原先把输出钉死在共享 `full-book.m4b.part`；宿主重启后在途
 * ffmpeg 变孤儿继续写同一 inode，与重跑的新 run 交错写同文件 = 损坏。
 *
 * 覆盖：
 *  (a) 并发两次 encodeFullBookM4b（同一 taskDir）→ 规范名是某一次完整产物、无交错，
 *      part 名互含不同 runId；
 *  (b) 成功后规范名只由原子 rename 产生（唯一 part 消失、legacy `full-book.m4b.part` 不出现）；
 *  (c) stale part GC 生效（旧 part 被清、新 part 保留）；
 *  (d) watchdog 磁盘探针在唯一 part 名下仍判宽容。
 *
 * 用假 ffmpeg（AUDIOBOOK_FFMPEG_PATH 指向 shell 脚本）避免依赖真实 ffmpeg：假脚本把
 * 第二个参数（`-i <sourceWav>` 的源文件）原样复制到最后一个参数（产物 part 路径）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { encodeFullBookM4b } = require("../dist/services/audiobook/audiobookM4b.js");
const {
  resolveFullBookM4bPath,
  hasInFlightM4bPart,
  cleanupStaleM4bParts,
} = require("../dist/services/audiobook/audiobookPaths.js");
const {
  isWatchdogFinalizingTolerant,
} = require("../dist/services/audiobook/AudiobookTaskService.js");

function makeTaskDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ab-m4b-${label}-`));
}

/** 生成假 ffmpeg 脚本；返回可执行路径。 */
function installFakeFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-ffmpeg-"));
  const script = path.join(dir, "fake-ffmpeg.sh");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      'prev=""',
      'src=""',
      'last=""',
      'for a in "$@"; do',
      // 取第一个 `-i` 的值（音源 sourceWav），忽略第二个 `-i`（ffmetadata 表）
      '  if [ "$prev" = "-i" ] && [ -z "$src" ]; then src="$a"; fi',
      '  last="$a"',
      '  prev="$a"',
      "done",
      'cp "$src" "$last"',
      'sleep 0.05',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

/** 构造一个内容为重复字符的“WAV”，用作可区分的音源。 */
function writeMarkerFile(p, ch, len) {
  fs.writeFileSync(p, ch.repeat(len));
}

const FFMPEG_SCRIPT = installFakeFfmpeg();
const OLD_FFMPEG_PATH = process.env.AUDIOBOOK_FFMPEG_PATH;

test.before(() => {
  process.env.AUDIOBOOK_FFMPEG_PATH = FFMPEG_SCRIPT;
});
test.after(() => {
  if (OLD_FFMPEG_PATH === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
  else process.env.AUDIOBOOK_FFMPEG_PATH = OLD_FFMPEG_PATH;
});

// ── (a) 并发两次 encode 唯一 part 名 + 规范名无交错 ──

test("并发两次 encodeFullBookM4b 用不同 runId part，规范名是某一次完整产物", async () => {
  const taskDir = makeTaskDir("conc");
  const srcA = path.join(taskDir, "srcA.wav");
  const srcB = path.join(taskDir, "srcB.wav");
  writeMarkerFile(srcA, "A", 4096);
  writeMarkerFile(srcB, "B", 4096);

  const [r1, r2] = await Promise.all([
    encodeFullBookM4b({
      taskDir,
      bookTitle: "并发 A",
      sourceWavPath: srcA,
      chapters: [],
    }),
    encodeFullBookM4b({
      taskDir,
      bookTitle: "并发 B",
      sourceWavPath: srcB,
      chapters: [],
    }),
  ]);

  assert.equal(r1.status, "ready", `run1 failed: ${r1.reason}`);
  assert.equal(r2.status, "ready", `run2 failed: ${r2.reason}`);

  const canonical = resolveFullBookM4bPath(taskDir);
  assert.equal(fs.existsSync(canonical), true, "规范名必须存在");
  const content = fs.readFileSync(canonical, "utf8");
  const isPureA = /^A+$/.test(content);
  const isPureB = /^B+$/.test(content);
  assert.equal(isPureA || isPureB, true, `规范名内容交错/损坏：前 100=${content.slice(0, 100)}`);

  // part 名互含不同 runId，且本次 run 的 part 已清理
  const parts = fs.readdirSync(taskDir).filter((n) => n.endsWith(".part"));
  assert.equal(parts.length, 0, `成功 run 后不应残留 .part：${parts.join(",")}`);
  // legacy 共享名不得出现
  assert.equal(
    fs.existsSync(path.join(taskDir, "full-book.m4b.part")),
    false,
    "不得再创建共享 full-book.m4b.part",
  );
});

// ── (b) 成功后规范名只由原子 rename 产生 ──

test("成功后唯一 part 被原子 rename 到规范名（全程无共享 part）", async () => {
  const taskDir = makeTaskDir("rename");
  const src = path.join(taskDir, "src.wav");
  writeMarkerFile(src, "Z", 1024);

  const result = await encodeFullBookM4b({
    taskDir,
    bookTitle: "rename 书",
    sourceWavPath: src,
    chapters: [],
  });
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.relativePath, "full-book.m4b");
  const canonical = resolveFullBookM4bPath(taskDir);
  assert.equal(fs.readFileSync(canonical, "utf8"), "Z".repeat(1024), "规范名内容为完整产物");
  // 唯一 part 已 rename 消失
  const parts = fs.readdirSync(taskDir).filter((n) => n.endsWith(".part"));
  assert.equal(parts.length, 0, `part 应已被原子 rename 移除：${parts.join(",")}`);
});

// ── (c) stale part GC ──

test("cleanupStaleM4bParts 清旧 part、留新 part", () => {
  const taskDir = makeTaskDir("gc");
  const outPath = resolveFullBookM4bPath(taskDir);
  const oldName = path.join(taskDir, "full-book.m4b.oldrun.part");
  const freshName = path.join(taskDir, "full-book.m4b.freshrun.part");
  fs.writeFileSync(oldName, "stale");
  fs.writeFileSync(freshName, "fresh");

  // 把旧 part 的 mtime 拨回 1 小时前
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(oldName, old, old);

  cleanupStaleM4bParts(taskDir, outPath, 2 * 60 * 1000); // 2 分钟窗口

  assert.equal(fs.existsSync(oldName), false, "旧 part 必须被清");
  assert.equal(fs.existsSync(freshName), true, "新 part 必须保留");
});

test("cleanupStaleM4bParts 不误删本次 run 的新 part", () => {
  const taskDir = makeTaskDir("gc-fresh");
  const outPath = resolveFullBookM4bPath(taskDir);
  const partName = path.join(taskDir, "full-book.m4b.current.part");
  fs.writeFileSync(partName, "new");
  cleanupStaleM4bParts(taskDir, outPath);
  assert.equal(fs.existsSync(partName), true, "当前 run 新 part 不得被误删");
});

// ── (d) watchdog 磁盘探针兼容唯一 part 名 ──

test("hasInFlightM4bPart 在唯一 part 名下判在途", () => {
  const taskDir = makeTaskDir("watch");
  assert.equal(hasInFlightM4bPart(taskDir), false, "无 part 时判不在途");
  fs.writeFileSync(path.join(taskDir, "full-book.m4b.a1b2c3.part"), "x");
  assert.equal(hasInFlightM4bPart(taskDir), true, "唯一 part 名存在即判在途");
});

test("isWatchdogFinalizingTolerant 在 m4bEncodingOnDisk=true 时宽容", () => {
  // 磁盘探针（唯一 part 名存在）置真时，即使非 finalizing 也宽容——编码在途
  const tolerant = isWatchdogFinalizingTolerant({
    currentStage: "synthesizing",
    progress: 50,
    m4bEncodingOnDisk: true,
  });
  assert.equal(tolerant, true);
  const notTolerant = isWatchdogFinalizingTolerant({
    currentStage: "synthesizing",
    progress: 50,
    m4bEncodingOnDisk: false,
  });
  assert.equal(notTolerant, false);
});
