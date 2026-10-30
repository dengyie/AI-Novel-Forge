const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCacheContextSections, renderCacheOrderedContextBlocks } = require('../dist/prompting/core/cache/index.js');
const { chapterWriterPrompt } = require('../dist/prompting/prompts/novel/chapterWriter.prompts.js');
const { chapterAcceptanceAssessmentPrompt } = require('../dist/prompting/prompts/novel/chapterAcceptance.prompts.js');

// 移植自上游 2026-10-05 promptCacheLayout.test.js：稳定 scope 先于 request，
// 布局不改变选择结果；连续章节的稳定前缀字节一致，动态内容保持新鲜。
const context = () => ({
  blocks: [
    { id: 'mission', group: 'task', priority: 100, required: true, estimatedTokens: 10, content: '第1章任务', reuseScope: 'request' },
    { id: 'book', group: 'book_contract', priority: 100, required: true, estimatedTokens: 10, content: '书级文风', reuseScope: 'book' },
    { id: 'volume', group: 'volume_window', priority: 96, required: false, estimatedTokens: 10, content: '卷约束', reuseScope: 'volume' },
    { id: 'scene1', group: 'recent_chapters', priority: 90, required: false, estimatedTokens: 10, content: '场景甲' },
    { id: 'scene2', group: 'recent_chapters', priority: 90, required: false, estimatedTokens: 10, content: '场景乙' },
  ],
  selectedBlockIds: ['mission', 'book', 'volume', 'scene1', 'scene2'],
  droppedBlockIds: ['extra'],
  summarizedBlockIds: [],
  estimatedInputTokens: 100,
});

test('stable scopes precede request blocks without changing selection or semantic order', () => {
  const c = context();
  const before = JSON.stringify(c);
  assert.equal(renderCacheOrderedContextBlocks(c), '书级文风\n\n卷约束\n\n第1章任务\n\n场景甲\n\n场景乙');
  assert.equal(JSON.stringify(c), before);
  const parts = renderCacheContextSections(c);
  assert.equal(parts.stable, '书级文风\n\n卷约束');
  assert.ok(parts.dynamic.includes('场景甲\n\n场景乙'));
});

test('writer and acceptance retain identical stable prefix across chapter changes; state stays fresh', () => {
  for (const asset of [chapterWriterPrompt, chapterAcceptanceAssessmentPrompt]) {
    const a = context();
    const b = context();
    b.blocks[0].content = '第2章任务';
    const input = {
      novelTitle: '本书', chapterOrder: 1, chapterTitle: '章一', targetWordCount: 3000,
      minWordCount: 2700, maxWordCount: 3300, content: '正文',
    };
    const render = (i, c) => asset.render(i, c).map((m) => m.content).join('\n');
    const first = render(input, a);
    const second = render({ ...input, chapterOrder: 2, chapterTitle: '章二', targetWordCount: 4000, content: '新正文' }, b);
    const stableEnd = first.indexOf('卷约束') + '卷约束'.length;
    assert.ok(stableEnd > 0);
    assert.equal(first.slice(0, stableEnd), second.slice(0, stableEnd));
    assert.ok(second.includes('第2章任务'));
    assert.ok(second.includes('4000'));
    b.blocks[1].content = '编辑后的文风';
    const edited = render(input, b);
    assert.ok(edited.includes('编辑后的文风'));
    assert.ok(!edited.includes('书级文风'));
  }
});
