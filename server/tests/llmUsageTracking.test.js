const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractLlmTokenUsage,
  mergeStreamTokenUsage,
} = require("../dist/llm/usageTracking.js");
const {
  toTaskTokenUsageSummary,
} = require("../dist/services/task/taskTokenUsageSummary.js");

test("extractLlmTokenUsage reads usage_metadata returned by langchain messages", () => {
  const usage = extractLlmTokenUsage({
    usage_metadata: {
      input_tokens: 128,
      output_tokens: 64,
      total_tokens: 192,
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 128,
    completionTokens: 64,
    totalTokens: 192,
    inputCache: { cacheHitTokens: null, cacheMissTokens: null, cacheWriteTokens: null, cacheUsageStatus: "unavailable" },
  });
});

test("extractLlmTokenUsage falls back to response_metadata usage payload", () => {
  const usage = extractLlmTokenUsage({
    response_metadata: {
      usage: {
        prompt_tokens: 40,
        completion_tokens: 15,
        total_tokens: 55,
      },
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 40,
    completionTokens: 15,
    totalTokens: 55,
    inputCache: { cacheHitTokens: null, cacheMissTokens: null, cacheWriteTokens: null, cacheUsageStatus: "unavailable" },
  });
});

test("mergeStreamTokenUsage keeps the final stream totals instead of double counting chunks", () => {
  const merged = mergeStreamTokenUsage(
    {
      promptTokens: 0,
      completionTokens: 8,
      totalTokens: 8,
    },
    {
      promptTokens: 120,
      completionTokens: 36,
      totalTokens: 156,
    },
  );

  assert.deepEqual(merged, {
    promptTokens: 120,
    completionTokens: 36,
    totalTokens: 156,
  });
});

test("toTaskTokenUsageSummary hides empty counters and serializes active totals", () => {
  assert.equal(toTaskTokenUsageSummary({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    llmCallCount: 0,
    lastTokenRecordedAt: null,
  }), null);

  const summary = toTaskTokenUsageSummary({
    promptTokens: 320,
    completionTokens: 180,
    totalTokens: 500,
    llmCallCount: 6,
    lastTokenRecordedAt: new Date("2026-04-05T12:00:00.000Z"),
  });

  assert.deepEqual(summary, {
    promptTokens: 320,
    completionTokens: 180,
    totalTokens: 500,
    llmCallCount: 6,
    lastRecordedAt: "2026-04-05T12:00:00.000Z",
  });
});

test("toTaskTokenUsageSummary reports cache totals only from provider-reported calls", () => {
  assert.equal(toTaskTokenUsageSummary({
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    llmCallCount: 2,
    lastTokenRecordedAt: null,
  })?.inputCache ?? null, null);

  const partial = toTaskTokenUsageSummary({
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    llmCallCount: 3,
    cacheHitTokens: 800,
    cacheMissTokens: 200,
    cacheReportedCount: 2,
    lastTokenRecordedAt: null,
  });
  assert.deepEqual(partial?.inputCache, { cacheHitTokens: 800, cacheMissTokens: 200, complete: false });

  const complete = toTaskTokenUsageSummary({
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    llmCallCount: 2,
    cacheHitTokens: 800,
    cacheMissTokens: 200,
    cacheReportedCount: 2,
    lastTokenRecordedAt: null,
  });
  assert.deepEqual(complete?.inputCache, { cacheHitTokens: 800, cacheMissTokens: 200, complete: true });
});
