const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  coerceProviderForModelId,
  dedupeFallbackChain,
  normalizeStructuredFallbackHop,
  resolveStructuredFallbackChain,
} = require("../dist/llm/structuredFallbackSettings.js");

test("dedupeFallbackChain keeps first occurrence of provider+model", () => {
  const chain = dedupeFallbackChain([
    { provider: "deepseek", model: "deepseek-v4-pro", temperature: 0.2, maxTokens: null },
    { provider: "deepseek", model: "deepseek-v4-flash", temperature: 0.2, maxTokens: null },
    { provider: "deepseek", model: "deepseek-v4-pro", temperature: 0.1, maxTokens: 1024 },
  ]);
  assert.deepEqual(chain.map((h) => h.model), ["deepseek-v4-pro", "deepseek-v4-flash"]);
});

test("resolveStructuredFallbackChain skips primary and respects enabled flag", () => {
  const settings = {
    enabled: true,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    temperature: 0.2,
    maxTokens: null,
    chain: [
      { provider: "deepseek", model: "deepseek-v4-pro", temperature: 0.2, maxTokens: null },
      { provider: "deepseek", model: "deepseek-v4-flash", temperature: 0.2, maxTokens: null },
    ],
  };
  assert.deepEqual(
    resolveStructuredFallbackChain(settings, { provider: "openai", model: "grok-4.5" }).map((h) => h.model),
    ["deepseek-v4-pro", "deepseek-v4-flash"],
  );
  assert.deepEqual(
    resolveStructuredFallbackChain(settings, { provider: "deepseek", model: "deepseek-v4-pro" }).map((h) => h.model),
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
    provider: "deepseek",
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

test("coerceProviderForModelId rewrites openai+deepseek-* to deepseek provider slot", () => {
  assert.equal(coerceProviderForModelId("openai", "deepseek-v4-pro"), "deepseek");
  assert.equal(coerceProviderForModelId("openai", "deepseek-v4-flash"), "deepseek");
  assert.equal(coerceProviderForModelId("openai", "deepseek-ai/deepseek-v4-pro"), "deepseek");
  // leave non-deepseek alone
  assert.equal(coerceProviderForModelId("openai", "gpt-5.5"), "openai");
  assert.equal(coerceProviderForModelId("openai", "grok-4.5"), "openai");
  // leave explicit deepseek alone
  assert.equal(coerceProviderForModelId("deepseek", "deepseek-v4-pro"), "deepseek");
});

test("normalizeStructuredFallbackHop coerces openai+deepseek on save/build path", () => {
  const hop = normalizeStructuredFallbackHop({
    provider: "openai",
    model: "deepseek-v4-pro",
    temperature: 0.2,
    maxTokens: null,
  });
  assert.ok(hop);
  assert.equal(hop.provider, "deepseek");
  assert.equal(hop.model, "deepseek-v4-pro");
  assert.equal(hop.temperature, 0.2);

  const flash = normalizeStructuredFallbackHop({
    provider: "openai",
    model: "deepseek-v4-flash",
  });
  assert.ok(flash);
  assert.equal(flash.provider, "deepseek");

  // non-deepseek stays on openai
  const gpt = normalizeStructuredFallbackHop({
    provider: "openai",
    model: "gpt-5.5",
  });
  assert.ok(gpt);
  assert.equal(gpt.provider, "openai");
});
