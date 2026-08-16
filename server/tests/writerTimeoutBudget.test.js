const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveWriterTimeoutMs } = require("../dist/services/novel/writerTimeoutBudget.js");

// D1：writer 超时预算公式重构。
// 旧公式单一常量 WRITER_CHARS_PER_SECOND=25 对 gemini（实测 ~13.5 字/秒）乐观 1.85×，
// 整章 draft 撞墙。新公式按 (model) 维度取实测吞吐参数；未知 model 回落保守默认
// （不乐观于已知最慢模型），避免新模型重蹈「短 probe 全过、长 draft 挂」覆辙。
// 会让本测试失败的产品改动：吞吐参数表消失、回落到 25 字/秒乐观常量、或 floor/ceiling 漂移。

const FLOOR_MS = 480_000;
const CEILING_MS = 1_500_000;
const HEADROOM = 1.6;

test("no target word count returns floor", () => {
  assert.equal(resolveWriterTimeoutMs({ targetWordCount: 0 }), FLOOR_MS);
  assert.equal(resolveWriterTimeoutMs({ targetWordCount: null }), FLOOR_MS);
  assert.equal(resolveWriterTimeoutMs({ targetWordCount: undefined }), FLOOR_MS);
  assert.equal(resolveWriterTimeoutMs({}), FLOOR_MS);
});

test("short probe-level target does not regress below floor", () => {
  // ~1500 字短续写 probe：旧公式 1500/25*1.6=96s→floor 480s；新公式也必须保 floor。
  const ms = resolveWriterTimeoutMs({ targetWordCount: 1500 });
  assert.equal(ms, FLOOR_MS);
});

test("gemini 8000-char chapter budget exceeds the old optimistic 25 cps budget", () => {
  // 旧公式：8000/25*1.6 = 512s（生产实测撞墙，81% 处被掐）。
  // gemini 实测 13.5 字/秒：8000/13.5*1.6 ≈ 948s。必须 > 512s，否则公式仍乐观。
  const ms = resolveWriterTimeoutMs({ targetWordCount: 8000, model: "gemini-3.7-flash-high" });
  assert.ok(ms > 512_000, `gemini budget ${ms}ms must exceed old optimistic 512s to avoid wall`);
  assert.ok(ms <= CEILING_MS, "gemini budget must respect ceiling");
});

test("gemini budget matches measured throughput within headroom", () => {
  // 8000 字 / 13.5 字/秒 * 1.6 ≈ 948s。允许 floor/ceiling 钳制后的精确值。
  const expected = Math.min(CEILING_MS, Math.max(FLOOR_MS, Math.ceil(8000 / 13.5 * 1000 * HEADROOM)));
  const ms = resolveWriterTimeoutMs({ targetWordCount: 8000, model: "gemini-3.7-flash-high" });
  assert.equal(ms, expected);
});

test("unknown model falls back to conservative default, not the optimistic 25 cps", () => {
  // 未知 model 不得复用旧的 25 字/秒乐观常量。回落吞吐必须 <= 已知最慢模型（gemini 13.5），
  // 否则新接入模型会重蹈 gemini 撞墙覆辙。8000 字下：
  //   25 cps → 512s（旧，撞墙）；13.5 cps → 948s；回落应 >= 948s 量级（保守）。
  const ms = resolveWriterTimeoutMs({ targetWordCount: 8000 });
  assert.ok(ms >= 948_000, `unknown model budget ${ms}ms must be conservative (>= gemini measured)`);
});

test("ceiling clamps very long chapters", () => {
  // 50000 字章节：即便最慢吞吐也不应超过 ceiling。
  const ms = resolveWriterTimeoutMs({ targetWordCount: 50_000, model: "gemini-3.7-flash-high" });
  assert.equal(ms, CEILING_MS);
});

test("budget is monotonic non-decreasing in target word count", () => {
  const a = resolveWriterTimeoutMs({ targetWordCount: 4000, model: "gemini-3.7-flash-high" });
  const b = resolveWriterTimeoutMs({ targetWordCount: 8000, model: "gemini-3.7-flash-high" });
  const c = resolveWriterTimeoutMs({ targetWordCount: 16000, model: "gemini-3.7-flash-high" });
  assert.ok(b >= a, "budget must not shrink as target grows");
  assert.ok(c >= b, "budget must not shrink as target grows");
});

test("deepseek-v4-pro uses its own throughput, distinct from gemini", () => {
  // deepseek-v4-pro 注释实测 ~15-20 tok/s（CJK 约 1 tok≈1-2 字，取保守下限登记）。
  // 同样 8000 字，deepseek 预算应与 gemini 不同（不同吞吐参数）。
  const gemini = resolveWriterTimeoutMs({ targetWordCount: 8000, model: "gemini-3.7-flash-high" });
  const deepseek = resolveWriterTimeoutMs({ targetWordCount: 8000, model: "deepseek-v4-pro" });
  // 两者都 > 旧 512s 撞墙预算（都不应乐观）
  assert.ok(gemini > 512_000);
  assert.ok(deepseek > 512_000);
  // 不强制谁大谁小（取决于登记吞吐），但必须不等于单一常量产物
  assert.ok(deepseek !== gemini || deepseek === CEILING_MS, "deepseek should use its own throughput param");
});
