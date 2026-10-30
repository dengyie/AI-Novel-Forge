const test = require('node:test');
const assert = require('node:assert/strict');

// 上游 2026-10-17「自定义检查重试次数及耗尽处理」最小面：预算上限 env 可配置、
// 钳位防呆；阶梯语义（patch→rewrite→replan→hard_stop）保持不变。
const { resolveQualityLoopBudgetLimits } = require('../dist/services/novel/qualityLoopBudget.js');
const { resolveQualityLoopMaxAttempts } = require('../../shared/dist/types/chapterQualityLoop.js');

test('quality loop budget limits default to the shipped escalation ladder', () => {
  assert.deepEqual(resolveQualityLoopBudgetLimits({}), { patchRepair: 2, chapterRewrite: 1, windowReplan: 1 });
});

test('quality loop budget limits clamp env overrides into safe ranges', () => {
  assert.deepEqual(
    resolveQualityLoopBudgetLimits({ QUALITY_LOOP_PATCH_REPAIR_LIMIT: '4', QUALITY_LOOP_CHAPTER_REWRITE_LIMIT: '2' }),
    { patchRepair: 4, chapterRewrite: 2, windowReplan: 1 },
  );
  assert.deepEqual(
    resolveQualityLoopBudgetLimits({ QUALITY_LOOP_PATCH_REPAIR_LIMIT: '99', QUALITY_LOOP_CHAPTER_REWRITE_LIMIT: '-3', QUALITY_LOOP_WINDOW_REPLAN_LIMIT: 'abc' }),
    { patchRepair: 5, chapterRewrite: 0, windowReplan: 1 },
  );
});

test('shared loop max attempts only tighten within the fixed 3-step ladder', () => {
  assert.equal(resolveQualityLoopMaxAttempts({}), 3);
  assert.equal(resolveQualityLoopMaxAttempts({ QUALITY_LOOP_MAX_ATTEMPTS: '1' }), 1);
  assert.equal(resolveQualityLoopMaxAttempts({ QUALITY_LOOP_MAX_ATTEMPTS: '8' }), 3);
  assert.equal(resolveQualityLoopMaxAttempts({ QUALITY_LOOP_MAX_ATTEMPTS: '0.5' }), 1);
});
