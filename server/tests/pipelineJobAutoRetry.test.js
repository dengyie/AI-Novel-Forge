const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("../dist/services/novel/pipelineJobState.js");

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
