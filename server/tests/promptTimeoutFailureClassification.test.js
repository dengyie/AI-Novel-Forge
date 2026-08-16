const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recordPromptFailure,
} = require("../dist/prompting/observability/PromptExecutionRecorder.js");
const {
  getPromptQualitySnapshot,
  resetPromptQualityTelemetryForTests,
} = require("../dist/prompting/core/promptQualityTelemetry.js");

// D2：超时失败必须被单独识别为 `timeout`，不能落进 llm_error。
// 真实行为驱动：造墙钟超时产生的 TimeoutError（invokeTimeout.ts:createTimeoutError 的形态），
// 经 recordPromptFailure → recordPromptQualityEvent → snapshot.failuresByKind。
// 会让本测试失败的产品改动：classifyPromptQualityFailure 不增加 timeout 分支，
// 或分支判据无法识别 TimeoutError / "timed out" 文案 / 泛化 AbortError。

function makeTimeoutError(message = "Request timed out after 480000ms.") {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function makeAsset() {
  return {
    id: "test.d2.timeout-classification",
    version: "v1",
    taskType: "chapter_writer",
    mode: "structured",
    render: () => [],
  };
}

function makeContext() {
  return {
    blocks: [],
    selectedBlockIds: [],
    droppedBlockIds: [],
    summarizedBlockIds: [],
    estimatedInputTokens: 0,
  };
}

function makeInvocation() {
  return {
    promptId: "test.d2.timeout-classification",
    promptVersion: "v1",
    taskType: "chapter_writer",
    contextBlockIds: [],
    droppedContextBlockIds: [],
    summarizedContextBlockIds: [],
    customAddendumBlockIds: [],
    estimatedInputTokens: 0,
    repairUsed: false,
    repairAttempts: 0,
    semanticRetryUsed: false,
    semanticRetryAttempts: 0,
  };
}

function failuresOfKind(kind) {
  const snapshots = getPromptQualitySnapshot();
  if (snapshots.length === 0) {
    return 0;
  }
  let total = 0;
  for (const entry of snapshots) {
    total += entry.failuresByKind[kind] ?? 0;
  }
  return total;
}

test("TimeoutError is classified as timeout, not llm_error", () => {
  resetPromptQualityTelemetryForTests();
  recordPromptFailure({
    asset: makeAsset(),
    context: makeContext(),
    invocation: makeInvocation(),
    latencyMs: 480_000,
    error: makeTimeoutError(),
  });
  assert.equal(failuresOfKind("timeout"), 1, "timeout failure should be classified as timeout");
  assert.equal(failuresOfKind("llm_error"), 0, "timeout must not leak into llm_error");
});

test("timeout takes priority over schema keyword in message", () => {
  resetPromptQualityTelemetryForTests();
  // 一个超时消息里恰好含 "json" —— 超时必须优先于 schema 兜底分支，
  // 否则含 schema 关键词的超时会被错误归进 schema_repair_failed。
  recordPromptFailure({
    asset: makeAsset(),
    context: makeContext(),
    invocation: makeInvocation(),
    latencyMs: 480_000,
    error: makeTimeoutError("Request timed out after 480000ms. (json context)"),
  });
  assert.equal(failuresOfKind("timeout"), 1);
  assert.equal(failuresOfKind("schema_repair_failed"), 0);
});

test("generic AbortError with timed-out message is classified as timeout", () => {
  resetPromptQualityTelemetryForTests();
  // invokeTimeout.ts 墙钟 abort 会把迟到 rejection 统一映射为 TimeoutError，
  // 但中途也可能冒出泛化 AbortError("Request was aborted.")（transportRetry 视为 timeout-driven）。
  // 复用同一判据：泛化 abort 文案 + 无显式取消标记 → timeout。
  const error = new Error("Request was aborted.");
  error.name = "AbortError";
  recordPromptFailure({
    asset: makeAsset(),
    context: makeContext(),
    invocation: makeInvocation(),
    latencyMs: 480_000,
    error,
  });
  assert.equal(failuresOfKind("timeout"), 1);
  assert.equal(failuresOfKind("llm_error"), 0);
});

test("explicit cancellation is not classified as timeout", () => {
  resetPromptQualityTelemetryForTests();
  // 显式取消（用户/导演主动 cancel）不得被 timeout 分支吞掉。
  // isTimeoutLikeTransportError 已排除 isCancellationLikeTransportError；
  // 这类应落 llm_error（或被上游 cancel 路径单独处理），但绝不是 timeout。
  // 用真实取消文案 PIPELINE_CANCELLED 真正命中 hasExplicitCancellationMessage，
  // 避免措辞巧合让测试虚假通过（code-review #3）。
  const error = new Error("PIPELINE_CANCELLED");
  recordPromptFailure({
    asset: makeAsset(),
    context: makeContext(),
    invocation: makeInvocation(),
    latencyMs: 1_000,
    error,
  });
  assert.equal(failuresOfKind("timeout"), 0, "explicit cancellation must not be timeout");
});

test("schema failure still classified as schema_repair_failed when not a timeout", () => {
  resetPromptQualityTelemetryForTests();
  recordPromptFailure({
    asset: makeAsset(),
    context: makeContext(),
    invocation: makeInvocation(),
    latencyMs: 2_000,
    error: new Error("zod validation failed: schema mismatch"),
  });
  assert.equal(failuresOfKind("schema_repair_failed"), 1);
  assert.equal(failuresOfKind("timeout"), 0);
});
