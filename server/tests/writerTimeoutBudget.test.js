const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveWriterTimeoutMs, WRITER_TIMEOUT_CONSTANTS } = require("../dist/services/novel/writerTimeoutBudget.js");

// D1 writer 超时预算公式 + A/B 校准（2026-08-17）。
//
// 旧登记 gemini=13.5 字/秒严重低估 8-10×。来源复盘：8/16 那次「三层同步验证」测出 13.5 字/秒
// 实为 CPA→Google oauth2 认证链路在拖（链路慢被当成模型吞吐）。CPA oauth2 修复后（2026-08-17）
// 实测 gemini-3.7-flash-high 经 CPA 流式吞吐：
//   短样本 4472字/38s = 117.7 字/秒；长 prompt 7838字/54s = 145.2 字/秒。
// 即模型真实吞吐约 117-145 字/秒，12K 章理论 ~83-102s。
//
// 但超时预算不能直接用峰值吞吐——CPA oauth2 偶发抖动、长文 context 退化、CPA 多渠道路由波动
// 都会让单次实际吞吐下移。故：
// - A：gemini 登记值从 13.5 下调到保守 35 字/秒（远低于实测下限 117，留 ~3.3× 余量给链路抖动）。
//   35 字/秒下 12K 预算 = 12000/35*1.6 ≈ 549s，既不撞墙也不浪费。
// - B：WRITER_TIMEOUT_MAX_MS 1500s→3000s，给 CPA oauth2 抖动恢复留空间（oauth2 一次握手失败
//   + 重试可能吃掉数百秒，旧 1500s 对 12K+ 章仍偏紧）。
// 铁律：只调超时预算，不调字数下限/节奏。
//
// 会让本测试失败的产品改动：登记吞吐 > 保守上限、回落 > 已知最慢、MAX_MS 回落 1500s、floor 漂移。

const FLOOR_MS = WRITER_TIMEOUT_CONSTANTS.MIN_MS;
const CEILING_MS = WRITER_TIMEOUT_CONSTANTS.MAX_MS;
const HEADROOM = WRITER_TIMEOUT_CONSTANTS.HEADROOM;
const GEMINI_CPS = WRITER_TIMEOUT_CONSTANTS.MODEL_CHARS_PER_SECOND["gemini-3.7-flash-high"];
const FALLBACK_CPS = WRITER_TIMEOUT_CONSTANTS.FALLBACK_CHARS_PER_SECOND;

test("constants: MAX_MS raised to 3000s for CPA oauth2 jitter headroom (B)", () => {
  assert.equal(CEILING_MS, 3_000_000, "MAX_MS must be 3000s (was 1500s) to absorb CPA oauth2 jitter");
});

test("constants: gemini registered throughput is conservative (A)", () => {
  // 实测 117-145 字/秒，登记值须远低于实测下限，给链路抖动留余量。
  assert.ok(GEMINI_CPS <= 50, `gemini cps ${GEMINI_CPS} must be conservative (< 50, measured floor ~117)`);
  assert.ok(GEMINI_CPS >= 20, `gemini cps ${GEMINI_CPS} must not be absurdly low (< 20 would over-budget)`);
});

test("constants: fallback not more optimistic than slowest known model", () => {
  assert.ok(FALLBACK_CPS <= GEMINI_CPS, `fallback ${FALLBACK_CPS} must not exceed slowest known ${GEMINI_CPS}`);
});

test("no target word count returns floor", () => {
  assert.equal(resolveWriterTimeoutMs({ targetWordCount: 0 }), FLOOR_MS);
  assert.equal(resolveWriterTimeoutMs({ targetWordCount: null }), FLOOR_MS);
  assert.equal(resolveWriterTimeoutMs({ targetWordCount: undefined }), FLOOR_MS);
  assert.equal(resolveWriterTimeoutMs({}), FLOOR_MS);
});

test("short probe-level target does not regress below floor", () => {
  // ~1500 字短续写 probe：floor 兜底必须保。
  const ms = resolveWriterTimeoutMs({ targetWordCount: 1500 });
  assert.equal(ms, FLOOR_MS);
});

test("gemini 12K chapter budget stays well under ceiling at conservative 35 cps (A)", () => {
  // 12K / 35 cps * 1.6 ≈ 549s。不应撞 3000s ceiling，也不应低于 floor。
  const ms = resolveWriterTimeoutMs({ targetWordCount: 12_000, model: "gemini-3.7-flash-high" });
  const expected = Math.min(CEILING_MS, Math.max(FLOOR_MS, Math.ceil(12_000 / GEMINI_CPS * 1000 * HEADROOM)));
  assert.equal(ms, expected);
  assert.ok(ms > FLOOR_MS, "12K must exceed floor");
  assert.ok(ms < CEILING_MS, "12K must not hit ceiling");
});

test("gemini budget no longer uses the old 13.5 cps underestimate", () => {
  // 旧 13.5 cps：12K/13.5*1.6 ≈ 1422s。新 35 cps：≈549s。新预算必须显著小于旧预算，
  // 否则登记值没改成功（仍乐观低估会把 oauth2 抖动误算）。
  const ms = resolveWriterTimeoutMs({ targetWordCount: 12_000, model: "gemini-3.7-flash-high" });
  const oldBudget = Math.min(1_500_000, Math.max(FLOOR_MS, Math.ceil(12_000 / 13.5 * 1000 * HEADROOM)));
  assert.ok(ms < oldBudget, `new budget ${ms}ms must be < old 13.5cps budget ${oldBudget}ms`);
});

test("unknown model falls back to conservative, not optimistic", () => {
  // 未知 model 回落吞吐必须 <= 已知最慢模型，不得乐观。
  const known = resolveWriterTimeoutMs({ targetWordCount: 12_000, model: "gemini-3.7-flash-high" });
  const unknown = resolveWriterTimeoutMs({ targetWordCount: 12_000 });
  assert.ok(unknown >= known, `unknown model budget ${unknown}ms must be >= slowest known ${known}ms`);
});

test("ceiling clamps very long chapters at 3000s", () => {
  // 70000 字章节：35 字/秒 + 1.6 headroom 会超过 3000s，必须被 ceiling 钳住。
  const ms = resolveWriterTimeoutMs({ targetWordCount: 70_000, model: "gemini-3.7-flash-high" });
  assert.equal(ms, CEILING_MS);
});

test("budget is monotonic non-decreasing in target word count", () => {
  const a = resolveWriterTimeoutMs({ targetWordCount: 4000, model: "gemini-3.7-flash-high" });
  const b = resolveWriterTimeoutMs({ targetWordCount: 8000, model: "gemini-3.7-flash-high" });
  const c = resolveWriterTimeoutMs({ targetWordCount: 16000, model: "gemini-3.7-flash-high" });
  assert.ok(b >= a, "budget must not shrink as target grows");
  assert.ok(c >= b, "budget must not shrink as target grows");
});

test("deepseek-v4-flash uses its own throughput, distinct from gemini", () => {
  const gemini = resolveWriterTimeoutMs({ targetWordCount: 12_000, model: "gemini-3.7-flash-high" });
  const deepseek = resolveWriterTimeoutMs({ targetWordCount: 12_000, model: "deepseek-v4-flash" });
  assert.ok(gemini > FLOOR_MS);
  assert.ok(deepseek > FLOOR_MS);
  assert.ok(deepseek !== gemini, "deepseek should use its own throughput param");
});
