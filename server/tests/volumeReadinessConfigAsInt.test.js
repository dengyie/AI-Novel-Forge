/**
 * volumeReadiness asInt: missing/empty env must use code fallbacks, not clamp-to-min.
 * Regression: Number("") === 0 was finite → perChapterTimeoutMs=60s, maxChapters=1, wall=1m.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const CONFIG_REL = "../dist/config/volumeReadiness.js";

function loadConfigFresh() {
  const abs = require.resolve(path.join(__dirname, CONFIG_REL));
  delete require.cache[abs];
  // Also clear any parent that re-exports if present
  return require(abs);
}

const ENV_KEYS = [
  "VOLUME_READINESS_MAX_CHAPTERS",
  "VOLUME_READINESS_MAX_HEAVY",
  "VOLUME_READINESS_MAX_LLM_CALLS",
  "VOLUME_READINESS_MAX_WALL_MINUTES",
  "VOLUME_READINESS_SCHEDULE_INTERVAL_MS",
  "VOLUME_READINESS_SCHEDULE",
  "VOLUME_READINESS_SIGNAL_STALE_HOURS",
  "VOLUME_READINESS_MAX_INCOMPLETE_RETRIES",
  "VOLUME_READINESS_PER_CHAPTER_TIMEOUT_MS",
  "VOLUME_READINESS_WALL_HEARTBEAT_MS",
];

describe("volumeReadiness config asInt empty-env fallback", () => {
  const saved = {};

  before(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    // leave cache dirty is fine for other files; re-load once more clean
    try {
      loadConfigFresh();
    } catch {
      // dist may be rebuilt later
    }
  });

  it("uses documented defaults when env keys are unset", () => {
    const mod = loadConfigFresh();
    const cfg = mod.volumeReadinessConfig;
    assert.equal(cfg.budget.maxChapters, 20);
    assert.equal(cfg.budget.maxHeavyRewrites, 3);
    assert.equal(cfg.budget.maxLlmCalls, 60);
    assert.equal(cfg.budget.maxWallMinutes, 180);
    assert.equal(cfg.perChapterTimeoutMs, 45 * 60 * 1000);
    assert.equal(cfg.wallHeartbeatMs, 30_000);
    assert.equal(cfg.maxIncompleteRetries, 3);
    assert.equal(cfg.signalStaleHours, 72);
  });

  it("empty-string env still falls back (not clamp-to-min 0)", () => {
    process.env.VOLUME_READINESS_MAX_CHAPTERS = "";
    process.env.VOLUME_READINESS_MAX_HEAVY = "   ";
    process.env.VOLUME_READINESS_PER_CHAPTER_TIMEOUT_MS = "";
    process.env.VOLUME_READINESS_MAX_WALL_MINUTES = "";
    const mod = loadConfigFresh();
    const cfg = mod.volumeReadinessConfig;
    assert.equal(cfg.budget.maxChapters, 20);
    assert.equal(cfg.budget.maxHeavyRewrites, 3);
    assert.equal(cfg.perChapterTimeoutMs, 45 * 60 * 1000);
    assert.equal(cfg.budget.maxWallMinutes, 180);
  });

  it("valid env is respected within clamp", () => {
    process.env.VOLUME_READINESS_MAX_CHAPTERS = "12";
    process.env.VOLUME_READINESS_PER_CHAPTER_TIMEOUT_MS = String(10 * 60 * 1000);
    process.env.VOLUME_READINESS_MAX_WALL_MINUTES = "240";
    const mod = loadConfigFresh();
    const cfg = mod.volumeReadinessConfig;
    assert.equal(cfg.budget.maxChapters, 12);
    assert.equal(cfg.perChapterTimeoutMs, 10 * 60 * 1000);
    assert.equal(cfg.budget.maxWallMinutes, 240);
  });
});
