const test = require('node:test');
const assert = require('node:assert/strict');
const { HumanMessage } = require('@langchain/core/messages');
const { createAnthropicLLM } = require('../dist/llm/anthropicClient.js');
const { extractLlmTokenUsage, mergeStreamTokenUsage } = require('../dist/llm/usageTracking.js');

// 移植自上游 2026-10-05 anthropicUsageStream.test.js：流式保留 usage-only 帧，
// UTF-8 分包/CRLF 正常，断流报告中断并保留部分用量，厂商错误原样透传。
test('Anthropic stream preserves usage-only events and text order across UTF8 splits', async () => {
  const previous = global.fetch;
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 180, output_tokens: 0 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '正文' } },
    { type: 'message_delta', usage: { output_tokens: 100 } },
    { type: 'message_stop' },
  ];
  const bytes = new TextEncoder().encode(events.map((e) => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join(''));
  global.fetch = async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }));
  try {
    const llm = createAnthropicLLM({ model: 'fixture', baseURL: 'https://fixture.invalid', temperature: 0 });
    let text = '';
    let usage = null;
    for await (const chunk of await llm.stream([new HumanMessage('写正文')])) {
      text += chunk.content;
      usage = mergeStreamTokenUsage(usage, extractLlmTokenUsage(chunk));
    }
    assert.equal(text, '正文');
    assert.equal(usage.promptTokens, 1000);
    assert.equal(usage.totalTokens, 1100);
    assert.equal(usage.inputCache.cacheHitTokens, 800);
    assert.equal(usage.inputCache.cacheMissTokens, 200);
  } finally {
    global.fetch = previous;
  }
});

async function fixture(events, consume) {
  const old = global.fetch;
  global.fetch = async () => new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
  try {
    return await consume(createAnthropicLLM({ model: 'fixture', baseURL: 'https://fixture.invalid', temperature: 0 }));
  } finally {
    global.fetch = old;
  }
}

test('missing cache stays unknown and usage-only stream preserves basic counts', () => fixture([
  { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 0 } } },
  { type: 'message_delta', usage: { output_tokens: 10 } },
  { type: 'message_stop' },
], async (llm) => {
  let usage = null;
  for await (const chunk of await llm.stream([new HumanMessage('fixture')])) {
    usage = mergeStreamTokenUsage(usage, extractLlmTokenUsage(chunk));
  }
  assert.equal(usage.totalTokens, 30);
  assert.equal(usage.inputCache.cacheHitTokens, null);
}));

test('provider SSE error is preserved', () => fixture([
  { type: 'error', error: { type: 'overloaded_error', message: 'original provider failure' } },
], async (llm) => {
  await assert.rejects(async () => { for await (const c of await llm.stream([new HumanMessage('fixture')])) {} }, /original provider failure/);
}));

test('truncated stream preserves partial counts and reports interruption', () => fixture([
  { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 0 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: '部分' } },
], async (llm) => {
  let text = '';
  let usage = null;
  await assert.rejects(async () => {
    for await (const c of await llm.stream([new HumanMessage('fixture')])) {
      text += c.content;
      usage = mergeStreamTokenUsage(usage, extractLlmTokenUsage(c));
    }
  }, /interrupted/);
  assert.equal(text, '部分');
  assert.equal(usage.promptTokens, 20);
}));
