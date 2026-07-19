const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveStructuredOutputProfile,
} = require("../dist/llm/structuredOutput.js");

test("deepseek-v4-pro via openai+CPA baseURL forces non-thinking structured profile", () => {
  const profile = resolveStructuredOutputProfile({
    provider: "openai",
    model: "deepseek-v4-pro",
    baseURL: "https://proxy.example.com/v1",
    executionMode: "structured",
  });
  assert.equal(profile.family, "deepseek");
  assert.equal(profile.requiresNonThinkingForStructured, true);
  assert.equal(profile.supportsReasoningToggle, true);
  assert.equal(profile.preferredStructuredStrategy, "json_object");
});

test("deepseek provider slot still works for v4-pro", () => {
  const profile = resolveStructuredOutputProfile({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    baseURL: "https://proxy.example.com/v1",
    executionMode: "structured",
  });
  assert.equal(profile.family, "deepseek");
  assert.equal(profile.requiresNonThinkingForStructured, true);
});

test("plain gpt on openai is not deepseek family", () => {
  const profile = resolveStructuredOutputProfile({
    provider: "openai",
    model: "gpt-5.5",
    baseURL: "https://api.openai.com/v1",
    executionMode: "structured",
  });
  assert.equal(profile.family, "openai");
  assert.equal(profile.requiresNonThinkingForStructured, false);
});
