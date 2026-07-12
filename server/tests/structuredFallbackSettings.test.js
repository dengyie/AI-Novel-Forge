const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  dedupeFallbackChain,
  resolveStructuredFallbackChain,
} = require("../dist/llm/structuredFallbackSettings.js");

test("dedupeFallbackChain keeps first occurrence of provider+model", () => {
  const chain = dedupeFallbackChain([
    { provider: "openai", model: "deepseek-v4-pro", temperature: 0.2, maxTokens: null },
    { provider: "openai", model: "deepseek-v4-flash", temperature: 0.2, maxTokens: null },
    { provider: "openai", model: "deepseek-v4-pro", temperature: 0.1, maxTokens: 1024 },
  ]);
  assert.deepEqual(chain.map((h) => h.model), ["deepseek-v4-pro", "deepseek-v4-flash"]);
});

test("resolveStructuredFallbackChain skips primary and respects enabled flag", () => {
  const settings = {
    enabled: true,
    provider: "openai",
    model: "deepseek-v4-pro",
    temperature: 0.2,
    maxTokens: null,
    chain: [
      { provider: "openai", model: "deepseek-v4-pro", temperature: 0.2, maxTokens: null },
      { provider: "openai", model: "deepseek-v4-flash", temperature: 0.2, maxTokens: null },
    ],
  };
  assert.deepEqual(
    resolveStructuredFallbackChain(settings, { provider: "openai", model: "grok-4.5" }).map((h) => h.model),
    ["deepseek-v4-pro", "deepseek-v4-flash"],
  );
  assert.deepEqual(
    resolveStructuredFallbackChain(settings, { provider: "openai", model: "deepseek-v4-pro" }).map((h) => h.model),
    ["deepseek-v4-flash"],
  );
  assert.deepEqual(
    resolveStructuredFallbackChain({ ...settings, enabled: false }, { provider: "openai", model: "grok-4.5" }),
    [],
  );
});

test("resolveStructuredFallbackChain falls back to legacy single hop when chain empty", () => {
  const settings = {
    enabled: true,
    provider: "openai",
    model: "deepseek-v4-flash",
    temperature: 0.2,
    maxTokens: null,
    chain: [],
  };
  assert.deepEqual(
    resolveStructuredFallbackChain(settings, { provider: "openai", model: "grok-4.5" }).map((h) => h.model),
    ["deepseek-v4-flash"],
  );
});
