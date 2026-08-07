const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAutoResumableStaleAutoDirectorTask,
} = require("../dist/services/novel/workflow/autoDirectorStaleTaskRecovery.js");

function buildSeed(autoExecution) {
  return JSON.stringify({ autoExecution });
}

test("isAutoResumableStaleAutoDirectorTask: resumable full-book autopilot → true", () => {
  const row = {
    cancelRequestedAt: null,
    seedPayloadJson: buildSeed({
      enabled: true,
      autoRepair: true,
      remainingChapterCount: 3,
      circuitBreaker: { status: "closed" },
    }),
  };
  assert.equal(isAutoResumableStaleAutoDirectorTask(row), true);
});

test("isAutoResumableStaleAutoDirectorTask: cancelled → false", () => {
  const row = {
    cancelRequestedAt: new Date(),
    seedPayloadJson: buildSeed({
      enabled: true,
      autoRepair: true,
      remainingChapterCount: 3,
    }),
  };
  assert.equal(isAutoResumableStaleAutoDirectorTask(row), false);
});

test("isAutoResumableStaleAutoDirectorTask: open circuit breaker → false", () => {
  const row = {
    cancelRequestedAt: null,
    seedPayloadJson: buildSeed({
      enabled: true,
      autoRepair: true,
      remainingChapterCount: 3,
      circuitBreaker: { status: "open" },
    }),
  };
  assert.equal(isAutoResumableStaleAutoDirectorTask(row), false);
});

test("isAutoResumableStaleAutoDirectorTask: no remaining chapters → false", () => {
  const row = {
    cancelRequestedAt: null,
    seedPayloadJson: buildSeed({
      enabled: true,
      autoRepair: true,
      remainingChapterCount: 0,
    }),
  };
  assert.equal(isAutoResumableStaleAutoDirectorTask(row), false);
});

test("isAutoResumableStaleAutoDirectorTask: auto-execution disabled → false", () => {
  const row = {
    cancelRequestedAt: null,
    seedPayloadJson: buildSeed({
      enabled: false,
      remainingChapterCount: 3,
    }),
  };
  assert.equal(isAutoResumableStaleAutoDirectorTask(row), false);
});

test("isAutoResumableStaleAutoDirectorTask: autoRepair explicitly off → false", () => {
  const row = {
    cancelRequestedAt: null,
    seedPayloadJson: buildSeed({
      enabled: true,
      autoRepair: false,
      remainingChapterCount: 3,
    }),
  };
  assert.equal(isAutoResumableStaleAutoDirectorTask(row), false);
});

test("isAutoResumableStaleAutoDirectorTask: missing seed payload → false", () => {
  const row = { cancelRequestedAt: null, seedPayloadJson: null };
  assert.equal(isAutoResumableStaleAutoDirectorTask(row), false);
  assert.equal(isAutoResumableStaleAutoDirectorTask({}), false);
});