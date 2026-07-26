/**
 * R2 单章墙钟预算纯逻辑单测。
 *
 * 测 makeChapterBudgetGuard 导出纯函数：超限抛 AppError(408)、未超限不抛。
 * 不 mock pipeline，不实跑 prisma。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  makeChapterBudgetGuard,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");

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

test("makeChapterBudgetGuard: label 是延迟求值的 thunk", async () => {
  let evaluated = false;
  const guard = makeChapterBudgetGuard(1_000, Date.now() - 5_000, () => {
    evaluated = true;
    return "延迟";
  });
  // label thunk 只在超限时调用
  assert.equal(evaluated, false);
  await assert.rejects(guard, (err) => {
    assert.equal(evaluated, true);
    assert.match(err.message, /延迟/);
    return true;
  });
});
