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
 * 用假 ffmpeg（AUDIOBOOK_FFMPEG_PATH）避免依赖真实编码，脚本自身 nohup/无子进程，
 * 便于测试后彻底回收：
 *  - slow-feed：循环追加写产物，tick 间隔可控（模拟慢编码但仍在推进）；
 *  - stall：写首字节后低 CPU 死循环（模拟卡死）。
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

/** 慢喂假 ffmpeg：每 $INTERVAL 秒追加 8 字节，直到 $MAX_SECONDS 或收到 SIGKILL。 */
function installSlowFeedFfmpeg(intervalSec, maxSec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-stall-ffmpeg-"));
  const script = path.join(dir, "slow-feed.sh");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      "exec >/dev/null 2>&1",
      "set -e",
      'out=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-i" ] && [ -z "$src" ]; then src="$a"; fi',
      '  last="$a"',
      '  prev="$a"',
      "done",
      'out="$last"',
      `: > "$out"`,
      `end=$(( $(date +%s) + ${maxSec} ))`,
      "while [ \"$(date +%s)\" -lt \"$end\" ]; do",
      // 每 tick 写 8 字节：既确保总量 > 64 字节通过体积门禁，又保持"稀疏但持续"推进。
      // 不调 sync：stat 走页缓存即时可见，避免落盘延迟在并发负载下追不上停滞窗口。
      "  printf \"XXXXXXXX\" >> \"$out\"",
      `  sleep "${intervalSec}"`,
      "done",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

/** 停滞假 ffmpeg：写 1 字节后低 CPU 死循环，只有外部 SIGKILL 能终止。 */
function installStallFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-stall-ffmpeg-"));
  const script = path.join(dir, "stall.sh");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      "exec >/dev/null 2>&1",
      'out=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-i" ] && [ -z "$src" ]; then src="$a"; fi',
      '  last="$a"',
      '  prev="$a"',
      "done",
      'printf "S" > "$last"',
      // 低 CPU 停滞：短睡循环（不派生长命子进程，看门狗 SIGKILL 父 shell 即整体消失，
      // 也不像纯忙循环那样 100% 自旋抢占并发测试进程）
      "while :; do sleep 0.05; done",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

function writeSrcWav(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(64)); // 假源文件，内容无所谓
}

test("慢但持续推进的编码不会因绝对时长被误杀（stall 看门狗按增长续命）", async () => {
  const intervalSec = 0.1; // 每 100ms 写 8 字节
  const maxSec = 4; // 假 ffmpeg 总共只写 ~4s 就自然退出（总字节 > 64 通过体积门禁）
  const fake = installSlowFeedFfmpeg(intervalSec, maxSec);
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake;
  // 停滞窗口 1200ms：即使推进粒度 100ms，余量仍达 12 倍；若看门狗误信墙钟（如同旧
  // 绝对超时模型）会在 1.2s 时误杀——而它其实一直在写，应顺利跑满 4s 判 ready。
  // 窗口取足够宽以吸收并发负载下的调度抖动，避免测试自身 flake。
  const stallTimeoutMs = 1200;

  const taskDir = makeTaskDir("slow");
  const src = path.join(taskDir, "src.wav");
  writeSrcWav(src);

  try {
    const r = await encodeFullBookM4b({ taskDir, bookTitle: "慢速书", sourceWavPath: src, chapters: [], stallTimeoutMs });
    assert.equal(r.status, "ready", `应正常完成：${r.reason ?? "（reason 为空）"}`);
    const canonical = path.join(taskDir, "full-book.m4b");
    assert.ok(fs.existsSync(canonical), "规范名产物存在");
    assert.ok(fs.statSync(canonical).size > 1, "产物有实际内容");
  } finally {
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
  }
});

test("产物连续停滞超过 stall 窗口 → 看门狗判死并报错", async () => {
  const fake = installStallFfmpeg();
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake;
  const stallTimeoutMs = 800;

  const taskDir = makeTaskDir("stall");
  const src = path.join(taskDir, "src.wav");
  writeSrcWav(src);

  try {
    const r = await encodeFullBookM4b({ taskDir, bookTitle: "停滞书", sourceWavPath: src, chapters: [], stallTimeoutMs });
    assert.equal(r.status, "failed", "停滞应被判 failed");
    assert.match(r.reason ?? "", /停滞/, `reason 应含停滞说明：${r.reason}`);
    // 部署语义：失败原因是「停滞」（不因绝对墙钟时长误杀），而非旧模型的绝对超时文案
    assert.doesNotMatch(r.reason ?? "", /绝对墙钟/);
  } finally {
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
  }
});