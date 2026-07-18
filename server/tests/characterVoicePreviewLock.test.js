/**
 * P1-a: per-character preview generate 锁。第二次并发 acquire 抛 409，release 后可再夺。
 */
const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  activePreviewGenerateKeys,
  acquirePreviewGenerateLock,
  releasePreviewGenerateLock,
} = require("../dist/services/audiobook/AudiobookVoiceAssetService.js");
const { AppError } = require("../dist/middleware/errorHandler.js");

describe("preview generate lock (P1-a)", () => {
  after(() => {
    activePreviewGenerateKeys.clear();
  });

  beforeEach(() => {
    activePreviewGenerateKeys.clear();
  });

  it("first acquire succeeds and second concurrent acquire throws 409", () => {
    const k1 = acquirePreviewGenerateLock("n1", "c1");
    assert.equal(activePreviewGenerateKeys.size, 1);
    assert.throws(
      () => acquirePreviewGenerateLock("n1", "c1"),
      (err) => err instanceof AppError && err.statusCode === 409,
    );
    releasePreviewGenerateLock(k1);
    assert.equal(activePreviewGenerateKeys.size, 0);
  });

  it("different characters acquire independently", () => {
    const k1 = acquirePreviewGenerateLock("n1", "c1");
    const k2 = acquirePreviewGenerateLock("n1", "c2");
    assert.equal(activePreviewGenerateKeys.size, 2);
    releasePreviewGenerateLock(k1);
    releasePreviewGenerateLock(k2);
    assert.equal(activePreviewGenerateKeys.size, 0);
  });

  it("release is idempotent (clearing twice is safe)", () => {
    const k = acquirePreviewGenerateLock("n", "c");
    releasePreviewGenerateLock(k);
    releasePreviewGenerateLock(k);
    assert.equal(activePreviewGenerateKeys.size, 0);
  });
});
