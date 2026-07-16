/**
 * 就绪 job 终态 / 进度 pure 规则：直接 import 与 service 共用的模块。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveVoiceReadinessJobTerminalStatus,
  resolveVoiceReadinessProgressWeights,
  resolveVoiceReadinessPreviewProgress,
} = require("../dist/services/audiobook/voiceReadinessJobLogic.js");

test("job terminal: cancel wins", () => {
  assert.equal(
    resolveVoiceReadinessJobTerminalStatus({
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
    resolveVoiceReadinessJobTerminalStatus({
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
    resolveVoiceReadinessJobTerminalStatus({
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
    resolveVoiceReadinessJobTerminalStatus({
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
    resolveVoiceReadinessJobTerminalStatus({
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
  const { weightVoice, weightPreview } = resolveVoiceReadinessProgressWeights({
    fillMissingVoice: true,
    generatePreview: true,
  });
  assert.equal(weightVoice + weightPreview, 100);
  assert.equal(weightVoice, 15);
  assert.equal(weightPreview, 85);

  const progress = resolveVoiceReadinessPreviewProgress({
    weightVoice,
    weightPreview,
    completedCount: 4,
    total: 4,
  });
  assert.equal(progress, 100);
});

test("progress weights: preview-only → 100", () => {
  const { weightVoice, weightPreview } = resolveVoiceReadinessProgressWeights({
    fillMissingVoice: false,
    generatePreview: true,
  });
  assert.equal(weightVoice, 0);
  assert.equal(weightPreview, 100);
});

test("progress weights: voice-only → 15 (preview weight 0)", () => {
  const { weightVoice, weightPreview } = resolveVoiceReadinessProgressWeights({
    fillMissingVoice: true,
    generatePreview: false,
  });
  assert.equal(weightVoice, 15);
  assert.equal(weightPreview, 0);
});
