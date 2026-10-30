const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { appendStructuredOutputHintMessages } = require('../dist/prompting/core/structuredOutputHint.js');

// 移植自上游 2026-10-05 promptCacheTemplateCompatibility.test.js：
// 静态骨架只在资产显式声明 stable_prefix 时前置且保持 Human 角色；
// 动态示例与高级模板保持尾部布局；注册资产按精确版本解析。
const c = { blocks: [], selectedBlockIds: [], droppedBlockIds: [], summarizedBlockIds: [], estimatedInputTokens: 0 };
const messages = [new SystemMessage('规则'), new HumanMessage('动态章节')];
const base = {
  id: 'fixture', mode: 'structured', outputSchema: z.object({ text: z.string() }),
  structuredOutputHint: { placement: 'stable_prefix', example: { text: '示例' }, note: '静态格式' },
};

test('explicit static hint is before dynamic material with Human role preserved', () => {
  const result = appendStructuredOutputHintMessages({ asset: base, context: c, promptInput: {}, messages });
  assert.equal(result[0].content, '规则');
  assert.match(result[1].content, /结构化输出/);
  assert.equal(result[1].getType(), 'human');
  assert.equal(result[2].content, '动态章节');
});

test('dynamic examples and advanced templates retain tail hint placement', () => {
  for (const asset of [
    { ...base, structuredOutputHint: { ...base.structuredOutputHint, example: () => ({ text: '当前内容' }) } },
    { ...base, structuredOutputHint: { ...base.structuredOutputHint, placement: 'tail' } },
  ]) {
    const result = appendStructuredOutputHintMessages({ asset, context: c, promptInput: {}, messages });
    assert.equal(result[1].content, '动态章节');
    assert.match(result[2].content, /结构化输出/);
  }
});

test('updated production assets resolve through registry at their exact versions', () => {
  const { getRegisteredPromptAsset } = require('../dist/prompting/registry.js');
  assert.equal(getRegisteredPromptAsset('novel.chapter.writer', 'v6').version, 'v6');
  assert.equal(getRegisteredPromptAsset('novel.chapter.acceptance_assessment', 'v2').version, 'v2');
});
