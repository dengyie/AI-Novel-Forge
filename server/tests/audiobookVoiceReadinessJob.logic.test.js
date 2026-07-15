/**
 * 就绪 job 终态判定（从 service 抽取的 pure 规则，避免依赖 prisma/TTS）。
 * 规则与 AudiobookVoiceReadinessService.runJob 对齐：
 * - cancelRequested → cancelled
 * - failed>0 && appliedVoice==0 && generatedPreview==0 && attempted → failed
 * - 否则 succeeded（含部分失败但有成功写入）
 */
const test = require("node:test");
const assert = require("node:assert/strict");

function resolveJobTerminalStatus(input) {
  const {
    cancelRequested,
    failed,
    appliedVoice,
    generatedPreview,
    attemptedVoiceApply,
    attemptedPreview,
  } = input;
  if (cancelRequested) {
    return "cancelled";
  }
  if (
    failed > 0
    && appliedVoice === 0
    && generatedPreview === 0
    && (attemptedVoiceApply || attemptedPreview)
  ) {
    return "failed";
  }
  return "succeeded";
}

test("job terminal: cancel wins", () => {
  assert.equal(
    resolveJobTerminalStatus({
      cancelRequested: true,
      failed: 3,
      appliedVoice: 0,
      generatedPreview: 0,
      attemptedVoiceApply: true,
      attemptedPreview: true,
    }),
    "cancelled",
  );
});

test("job terminal: all preview failed → failed", () => {
  assert.equal(
    resolveJobTerminalStatus({
      cancelRequested: false,
      failed: 2,
      appliedVoice: 0,
      generatedPreview: 0,
      attemptedVoiceApply: false,
      attemptedPreview: true,
    }),
    "failed",
  );
});

test("job terminal: partial preview fail still succeeded if some generated", () => {
  assert.equal(
    resolveJobTerminalStatus({
      cancelRequested: false,
      failed: 1,
      appliedVoice: 0,
      generatedPreview: 2,
      attemptedVoiceApply: false,
      attemptedPreview: true,
    }),
    "succeeded",
  );
});

test("job terminal: voice applied counts as success even if previews fail", () => {
  assert.equal(
    resolveJobTerminalStatus({
      cancelRequested: false,
      failed: 5,
      appliedVoice: 1,
      generatedPreview: 0,
      attemptedVoiceApply: true,
      attemptedPreview: true,
    }),
    "succeeded",
  );
});

test("job terminal: no-op attempt (nothing to do) → succeeded", () => {
  assert.equal(
    resolveJobTerminalStatus({
      cancelRequested: false,
      failed: 0,
      appliedVoice: 0,
      generatedPreview: 0,
      attemptedVoiceApply: false,
      attemptedPreview: false,
    }),
    "succeeded",
  );
});

test("progress weights: voice 15 + preview 85 when both on", () => {
  const fillMissingVoice = true;
  const generatePreview = true;
  const weightVoice = fillMissingVoice ? 15 : 0;
  const weightPreview = generatePreview ? (fillMissingVoice ? 85 : 100) : 0;
  assert.equal(weightVoice + weightPreview, 100);
  // after all previews
  const i = 3;
  const targetsLen = 4;
  const progress = Math.min(
    100,
    weightVoice + Math.round(((i + 1) / Math.max(targetsLen, 1)) * weightPreview),
  );
  assert.equal(progress, 100);
});
