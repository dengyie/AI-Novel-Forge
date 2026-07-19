const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ThinkTagStreamFilter,
  diffAccumulatedText,
  extractMessageTextForStructuredOutput,
  extractMiniMaxRawStreamData,
  extractReasoningTextFromChunk,
  isDeepSeekFamilyModelId,
  isDeepSeekThinkingCapableModelId,
  isDeepSeekThinkingModeProvider,
  isMiniMaxCompatibleProvider,
  normalizeModelId,
  resolveProviderReasoningBehavior,
} = require("../dist/llm/reasoning.js");

test("deepseek v4 pro behavior maps reasoning toggle to thinking mode", () => {
  const disabled = resolveProviderReasoningBehavior({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-v4-pro",
    reasoningEnabled: false,
  });

  assert.equal(disabled.reasoningEnabled, false);
  assert.equal(disabled.modelKwargs.thinking.type, "disabled");
  assert.equal(disabled.modelKwargs.enable_thinking, false);
  assert.equal(disabled.includeRawResponse, true);

  const enabled = resolveProviderReasoningBehavior({
    provider: "custom_gateway",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-reasoner",
    reasoningEnabled: true,
  });

  assert.equal(enabled.reasoningEnabled, true);
  assert.equal(enabled.modelKwargs.thinking.type, "enabled");
  assert.equal(enabled.modelKwargs.enable_thinking, true);
});

test("deepseek thinking mode is detected by model id on OpenAI-compatible proxies (CPA)", () => {
  assert.equal(isDeepSeekThinkingCapableModelId("deepseek-v4-pro"), true);
  assert.equal(isDeepSeekThinkingCapableModelId("deepseek-ai/deepseek-v4-pro"), true);
  assert.equal(isDeepSeekThinkingCapableModelId("deepseek-chat"), false);
  assert.equal(isDeepSeekFamilyModelId("deepseek-v4-flash"), true);

  // Critical production case: provider slot is openai, baseURL is CPA, model is deepseek-v4-pro.
  assert.equal(
    isDeepSeekThinkingModeProvider("openai", "https://proxy.example.com/v1", "deepseek-v4-pro"),
    true,
  );
  assert.equal(
    isDeepSeekThinkingModeProvider("openai", "https://proxy.example.com/v1", "deepseek-ai/deepseek-v4-pro"),
    true,
  );
  assert.equal(
    isDeepSeekThinkingModeProvider("deepseek", undefined, "deepseek-v4-pro"),
    true,
  );
  assert.equal(
    isDeepSeekThinkingModeProvider("custom_gateway", "https://api.deepseek.com/v1", "deepseek-reasoner"),
    true,
  );
  assert.equal(isDeepSeekThinkingModeProvider("deepseek", undefined, "deepseek-chat"), false);
  // Real OpenAI GPT models must not be treated as deepseek thinking.
  assert.equal(
    isDeepSeekThinkingModeProvider("openai", "https://api.openai.com/v1", "gpt-5.5"),
    false,
  );
  assert.equal(normalizeModelId("deepseek-ai/deepseek-v4-pro"), "deepseek-v4-pro");
});

test("CPA openai+deepseek-v4-pro forces thinking disabled kwargs when reasoningEnabled=false", () => {
  const behavior = resolveProviderReasoningBehavior({
    provider: "openai",
    baseURL: "https://proxy.example.com/v1",
    model: "deepseek-v4-pro",
    reasoningEnabled: false,
  });
  assert.deepEqual(behavior.modelKwargs.thinking, { type: "disabled" });
  assert.equal(behavior.modelKwargs.enable_thinking, false);
});

test("extractMessageTextForStructuredOutput falls back from null content to reasoning_content JSON", () => {
  const raw = extractMessageTextForStructuredOutput({
    content: null,
    additional_kwargs: {
      reasoning_content: '{"ok":true,"world":"x"}',
    },
  });
  assert.equal(raw, '{"ok":true,"world":"x"}');

  const emptyString = extractMessageTextForStructuredOutput({
    content: "",
    additional_kwargs: {
      reasoning_content: "not json at all",
    },
  });
  // Non-JSON reasoning is not preferred over empty content for structured parse.
  assert.equal(emptyString, "");

  const normal = extractMessageTextForStructuredOutput({
    content: '{"a":1}',
    additional_kwargs: {
      reasoning_content: '{"ignored":true}',
    },
  });
  assert.equal(normal, '{"a":1}');
});

test("minimax provider behavior enables reasoning_split and raw response parsing", () => {
  const behavior = resolveProviderReasoningBehavior({
    provider: "minimax",
    baseURL: "https://api.minimax.io/v1",
    model: "MiniMax-M2.7",
    reasoningEnabled: false,
  });

  assert.equal(behavior.reasoningEnabled, false);
  assert.equal(behavior.includeRawResponse, true);
  assert.equal(behavior.usesAccumulatedStreamDeltas, true);
  assert.deepEqual(behavior.modelKwargs, { reasoning_split: true });
});

test("minimax detection works for provider id, baseURL and model name", () => {
  assert.equal(isMiniMaxCompatibleProvider("minimax", undefined, undefined), true);
  assert.equal(isMiniMaxCompatibleProvider("custom_gateway", "https://api.minimaxi.com/v1", undefined), true);
  assert.equal(isMiniMaxCompatibleProvider("custom_gateway", undefined, "MiniMax-M2.5-highspeed"), true);
  assert.equal(isMiniMaxCompatibleProvider("openai", "https://api.openai.com/v1", "gpt-5"), false);
});

test("diffAccumulatedText returns only the appended suffix", () => {
  assert.deepEqual(
    diffAccumulatedText("你好", "你好，世界"),
    {
      nextBuffer: "你好，世界",
      delta: "，世界",
    },
  );
  assert.deepEqual(
    diffAccumulatedText("你好，世界", "你好"),
    {
      nextBuffer: "你好",
      delta: "",
    },
  );
});

test("extractMiniMaxRawStreamData reads accumulated content and reasoning buffers", () => {
  const parsed = extractMiniMaxRawStreamData({
    choices: [{
      delta: {
        content: "最终正文",
        reasoning_details: [{
          text: "完整思考链",
        }],
      },
    }],
  });

  assert.deepEqual(parsed, {
    contentBuffer: "最终正文",
    reasoningBuffer: "完整思考链",
  });
});

test("ThinkTagStreamFilter strips think tags across split chunks", () => {
  const filter = new ThinkTagStreamFilter();
  const first = filter.push("<thi");
  const second = filter.push("nk>先思考</think>回答");
  const flushed = filter.flush();

  assert.deepEqual(first, { text: "", reasoning: "" });
  assert.deepEqual(second, { text: "", reasoning: "先思考" });
  assert.deepEqual(flushed, { text: "回答", reasoning: "" });
});

test("extractReasoningTextFromChunk supports generic reasoning payloads", () => {
  const text = extractReasoningTextFromChunk({
    content: [{
      type: "reasoning",
      reasoning: "内容里的思考",
    }],
    additional_kwargs: {
      reasoning_content: "附加字段思考",
      reasoning: {
        summary: [{
          text: "总结思考",
        }],
      },
    },
  });
  assert.ok(text.includes("内容里的思考"));
  assert.ok(text.includes("附加字段思考"));
  assert.ok(text.includes("总结思考"));
});
