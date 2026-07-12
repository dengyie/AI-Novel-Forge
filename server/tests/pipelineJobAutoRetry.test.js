const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isPipelineCancellationError,
  isPipelineJobAutoRetryableError,
  shouldAutoRetryPipelineJob,
  formatPipelineJobAutoRetryMessage,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
} = require("../dist/services/novel/pipelineJobAutoRetry.js");
const {
  ChapterEmptyContentError,
} = require("../dist/services/novel/runtime/chapterEmptyContentError.js");
const {
  parsePipelinePayload,
  stringifyPipelinePayload,
  decoratePipelineJob,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_NOTICE_CODE,
} = require("../dist/services/novel/pipelineJobState.js");

test("isPipelineCancellationError covers cancel messages and AbortError abort text", () => {
  assert.equal(isPipelineCancellationError(new Error("PIPELINE_CANCELLED")), true);
  assert.equal(isPipelineCancellationError(new Error("章节生成已取消。")), true);
  assert.equal(isPipelineCancellationError(new Error("章节生成已取消，跳过正文定稿。")), true);
  assert.equal(isPipelineCancellationError(new Error("任务仍在取消中")), true);
  assert.equal(
    isPipelineCancellationError(Object.assign(new Error("Request aborted."), { name: "AbortError" })),
    true,
  );
  assert.equal(isPipelineCancellationError(new Error("fetch failed: ECONNRESET")), false);
  assert.equal(isPipelineCancellationError(new Error("502 Bad Gateway")), false);
});

test("isPipelineJobAutoRetryableError accepts transport and empty content", () => {
  assert.equal(isPipelineJobAutoRetryableError(new Error("fetch failed: ECONNRESET")), true);
  assert.equal(isPipelineJobAutoRetryableError(new Error("Request timed out after 30000ms.")), true);
  assert.equal(
    isPipelineJobAutoRetryableError(new ChapterEmptyContentError({
      source: "pipeline_chapter_writer",
      rawLength: 0,
      trimmedLength: 0,
    })),
    true,
  );
  assert.equal(isPipelineJobAutoRetryableError(new Error("PIPELINE_CANCELLED")), false);
  assert.equal(isPipelineJobAutoRetryableError(new Error("章节生成已取消。")), false);
  assert.equal(
    isPipelineJobAutoRetryableError(Object.assign(new Error("Request aborted."), { name: "AbortError" })),
    false,
  );
  assert.equal(
    isPipelineJobAutoRetryableError(Object.assign(new Error("wall clock"), { name: "AbortError" })),
    false,
  );
  assert.equal(isPipelineJobAutoRetryableError(new Error("invalid_api_key")), false);
});

test("shouldAutoRetryPipelineJob respects budget", () => {
  const err = new Error("502 Bad Gateway");
  assert.equal(shouldAutoRetryPipelineJob({ error: err, usedCount: 0, maxCount: 2 }), true);
  assert.equal(shouldAutoRetryPipelineJob({ error: err, usedCount: 1, maxCount: 2 }), true);
  assert.equal(shouldAutoRetryPipelineJob({ error: err, usedCount: 2, maxCount: 2 }), false);
  assert.equal(shouldAutoRetryPipelineJob({
    error: new Error("PIPELINE_CANCELLED"),
    usedCount: 0,
    maxCount: 2,
  }), false);
  assert.equal(shouldAutoRetryPipelineJob({
    error: Object.assign(new Error("Request aborted."), { name: "AbortError" }),
    usedCount: 0,
    maxCount: 2,
  }), false);
  assert.equal(shouldAutoRetryPipelineJob({
    error: new Error("schema mismatch"),
    usedCount: 0,
    maxCount: 5,
  }), false);
});

test("formatPipelineJobAutoRetryMessage includes attempt counter", () => {
  const msg = formatPipelineJobAutoRetryMessage({
    originalMessage: "fetch failed",
    nextCount: 1,
    maxCount: 2,
  });
  assert.match(msg, /1\/2/);
  assert.match(msg, /fetch failed/);
});

test("pipeline payload round-trips jobTransportAutoRetryCount", () => {
  const raw = stringifyPipelinePayload({
    provider: "deepseek",
    model: "deepseek-chat",
    jobTransportAutoRetryCount: 2,
    qualityAlertDetails: ["债1"],
  });
  const parsed = parsePipelinePayload(raw);
  assert.equal(parsed.jobTransportAutoRetryCount, 2);
  assert.deepEqual(parsed.qualityAlertDetails, ["债1"]);
});

test("PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX is non-negative", () => {
  assert.equal(typeof PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX, "number");
  assert.ok(PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX >= 0);
});

test("stringifyPipelinePayload omits jobTransportAutoRetryCount when zero", () => {
  const raw = stringifyPipelinePayload({
    provider: "deepseek",
    model: "deepseek-chat",
    jobTransportAutoRetryCount: 0,
  });
  const parsed = parsePipelinePayload(raw);
  assert.equal(parsed.jobTransportAutoRetryCount, undefined);
  assert.doesNotMatch(raw, /jobTransportAutoRetryCount/);
});

test("decoratePipelineJob surfaces queued auto-retry notice from payload count", () => {
  const error = formatPipelineJobAutoRetryMessage({
    originalMessage: "fetch failed: ECONNRESET",
    nextCount: 1,
    maxCount: 2,
  });
  const decorated = decoratePipelineJob({
    id: "job-auto-retry",
    status: "queued",
    error,
    payload: JSON.stringify({
      provider: "deepseek",
      model: "deepseek-chat",
      jobTransportAutoRetryCount: 1,
    }),
  });
  assert.equal(decorated.noticeCode, PIPELINE_JOB_TRANSPORT_AUTO_RETRY_NOTICE_CODE);
  assert.equal(decorated.displayStatus, "瞬时失败自动重试中");
  assert.match(decorated.noticeSummary, /1\/2/);
  assert.match(decorated.noticeSummary, /ECONNRESET/);
});

test("decoratePipelineJob surfaces running auto-retry notice without job.error", () => {
  const decorated = decoratePipelineJob({
    id: "job-auto-retry-running",
    status: "running",
    error: null,
    payload: JSON.stringify({
      jobTransportAutoRetryCount: 2,
    }),
  });
  assert.equal(decorated.noticeCode, PIPELINE_JOB_TRANSPORT_AUTO_RETRY_NOTICE_CODE);
  assert.equal(decorated.displayStatus, "瞬时失败自动重试中");
  assert.match(decorated.noticeSummary, /已用 2 次预算/);
});

test("decoratePipelineJob does not show auto-retry notice on succeeded jobs", () => {
  const decorated = decoratePipelineJob({
    id: "job-done",
    status: "succeeded",
    error: null,
    payload: JSON.stringify({
      jobTransportAutoRetryCount: 2,
      qualityAlertDetails: ["债1"],
    }),
  });
  assert.notEqual(decorated.noticeCode, PIPELINE_JOB_TRANSPORT_AUTO_RETRY_NOTICE_CODE);
  assert.equal(decorated.noticeCode, "PIPELINE_QUALITY_REVIEW");
});

test("decoratePipelineJob does not show auto-retry notice when count is zero", () => {
  const decorated = decoratePipelineJob({
    id: "job-fresh",
    status: "queued",
    error: null,
    payload: JSON.stringify({
      jobTransportAutoRetryCount: 0,
    }),
  });
  assert.equal(decorated.noticeCode, null);
  assert.equal(decorated.displayStatus, null);
});
