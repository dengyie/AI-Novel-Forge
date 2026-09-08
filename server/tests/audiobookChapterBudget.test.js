/**
 * R2 单章墙钟预算纯逻辑单测。
 *
 * - makeChapterBudgetGuard 导出纯函数：超限抛 AppError(408)、未超限不抛。
 * - computeChapterBudgetMs 动态预算：短章最小值 20min、长章按 chunk 数扩容、
 *   env 上限覆盖、单 chunk 预算可注入。核心回归：>150 chunks 预算 >= 60min。
 * 不 mock pipeline，不实跑 prisma。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  makeChapterBudgetGuard,
  computeChapterBudgetMs,
  AUDIOBOOK_CHAPTER_PER_CHUNK_BUDGET_MS,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");

// ── computeChapterBudgetMs 动态预算 ──

test("computeChapterBudgetMs: 短章取 floor 20min", () => {
  const budget = computeChapterBudgetMs(10);
  assert.ok(budget >= 20 * 60_000, `short chapter budget=${budget} should be >= 20min`);
  assert.equal(budget, 20 * 60_000);
});

test("computeChapterBudgetMs: 章 >150 chunks 预算 >= 60min（ch10/15/17/18 回归）", () => {
  const budget = computeChapterBudgetMs(200);
  assert.ok(budget >= 60 * 60_000, `200-chunk chapter budget=${budget} should be >= 60min`);
  // 每 chunk 默认 26s：200×26s ≈ 86.7min
  assert.ok(budget >= 200 * AUDIOBOOK_CHAPTER_PER_CHUNK_BUDGET_MS, "budget should scale with chunk count");
});

test("computeChapterBudgetMs: 显式 perChunkMs 缩放预算", () => {
  const budget = computeChapterBudgetMs(60, { perChunkMs: 30_000 });
  assert.ok(budget >= 60 * 30_000, "60 chunks × 30s should raise budget above 20min floor");
});

test("computeChapterBudgetMs: env AUDIOBOOK_CHAPTER_BUDGET_MS 是绝对上限", () => {
  const prev = process.env.AUDIOBOOK_CHAPTER_BUDGET_MS;
  try {
    process.env.AUDIOBOOK_CHAPTER_BUDGET_MS = String(30 * 60_000);
    const budget = computeChapterBudgetMs(1000);
    assert.ok(budget <= 30 * 60_000, "env cap should bound the dynamic budget");
    assert.ok(budget >= 20 * 60_000);
  } finally {
    if (prev === undefined) {
      delete process.env.AUDIOBOOK_CHAPTER_BUDGET_MS;
    } else {
      process.env.AUDIOBOOK_CHAPTER_BUDGET_MS = prev;
    }
  }
});

test("computeChapterBudgetMs: 无 chunk（=0）取 floor", () => {
  assert.equal(computeChapterBudgetMs(0), 20 * 60_000);
});

// ── makeChapterBudgetGuard ──

test("makeChapterBudgetGuard: 未超限 → 不抛", async () => {
  const guard = makeChapterBudgetGuard(60_000, Date.now(), () => "第 1 章");
  // 刚创建，距起点 < 1ms，不应超限
  await guard(); // should not throw
});

test("makeChapterBudgetGuard: 超限 → 抛 AppError 408", async () => {
  // startedAt 设成 30min 前，budgetMs=1min → 已超限
  const startedAt = Date.now() - 30 * 60_000;
  const guard = makeChapterBudgetGuard(60_000, startedAt, () => "第 5 章：测试");
  await assert.rejects(guard, (err) => {
    assert.equal(err.statusCode, 408);
    assert.match(err.message, /章节墙钟超限/);
    assert.match(err.message, /第 5 章：测试/);
    return true;
  });
});

test("makeChapterBudgetGuard: 刚好在边界前 → 不抛", async () => {
  // startedAt 设成 59s 前，budget=60s → 刚好没超
  const guard = makeChapterBudgetGuard(60_000, Date.now() - 59_000, () => "第 2 章");
  await guard(); // should not throw
});

test("makeChapterBudgetGuard: 超限消息包含分钟数", async () => {
  const guard = makeChapterBudgetGuard(20 * 60_000, Date.now() - 25 * 60_000, () => "第 3 章");
  await assert.rejects(guard, (err) => {
    assert.match(err.message, /20min/);
    return true;
  });
});

test("makeChapterBudgetGuard: label 是延迟求值的 thunk（超限才调用）", async () => {
  let evaluated = false;
  // guard 有 60s 下限；用 70s 前作为起点 → 必然超限；label 在构造时不得被调用
  const guard = makeChapterBudgetGuard(1_000, Date.now() - 70_000, () => {
    evaluated = true;
    return "延迟";
  });
  await assert.rejects(guard, (err) => {
    assert.equal(evaluated, true, "label thunk 应在抛错时被调用");
    assert.match(err.message, /延迟/);
    return true;
  });
  // 未超限的 guard 不应触发 label：新 guard 距起点 < 1ms，budget 未超限
  let touched = false;
  const okGuard = makeChapterBudgetGuard(60_000, Date.now(), () => {
    touched = true;
    return "不应出现";
  });
  await okGuard(); // 不抛
  assert.equal(touched, false, "未超限时 label thunk 不应被调用");
});

test("makeChapterBudgetGuard: setBudgetMs 可动态放宽（超限后放宽不再抛）", async () => {
  // startedAt 设成 25min 前，初始 floor 20min → 超限
  const guard = makeChapterBudgetGuard(20 * 60_000, Date.now() - 25 * 60_000, () => "第 8 章");
  await assert.rejects(guard, (err) => {
    assert.equal(err.statusCode, 408);
    return true;
  });
  // 标注完成 chunk 已知 → 放宽到 26s×300 chunks ≈ 130min → 不再超限
  guard.setBudgetMs(computeChapterBudgetMs(300));
  await guard(); // should not throw now
});

test("makeChapterBudgetGuard: setBudgetMs 不缩小到低于 60s floor", async () => {
  const guard = makeChapterBudgetGuard(60_000, Date.now(), () => "第 9 章");
  guard.setBudgetMs(1);
  await guard(); // floor 60s 兜底，刚创建不抛
});
