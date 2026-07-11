const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const {
  mapQualityScoreToChapterColumns,
} = require("../dist/services/novel/quality/chapterQualityScorePersist.js");

test("mapQualityScoreToChapterColumns flattens overall/coherence/voice/pacing", () => {
  const columns = mapQualityScoreToChapterColumns({
    coherence: 88,
    repetition: 91,
    pacing: 76,
    voice: 82,
    engagement: 85,
    overall: 84,
  });
  assert.deepEqual(columns, {
    qualityScore: 84,
    continuityScore: 88,
    characterScore: 82,
    pacingScore: 76,
  });
});

test("mapQualityScoreToChapterColumns clamps out-of-range and non-finite", () => {
  const columns = mapQualityScoreToChapterColumns({
    coherence: 150,
    repetition: -10,
    pacing: Number.NaN,
    voice: 50.6,
    engagement: 100,
    overall: -3,
  });
  assert.equal(columns.qualityScore, 0);
  assert.equal(columns.continuityScore, 100);
  assert.equal(columns.characterScore, 51);
  assert.equal(columns.pacingScore, 0);
});

test("finalize owns column-only persist; pipeline/manual/stream owns QualityReport write", () => {
  // 所有权契约：避免 finalize 与 createQualityReport 双写报告行。
  const finalizeSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/runtime/ChapterContentFinalizationService.ts"),
    "utf8",
  );
  const reviewSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/novelCoreReviewService.ts"),
    "utf8",
  );
  const streamSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/runtime/ChapterStreamGenerationOrchestrator.ts"),
    "utf8",
  );
  assert.match(finalizeSrc, /writeReport:\s*false/);
  assert.doesNotMatch(finalizeSrc, /writeReport:\s*true/);
  assert.match(reviewSrc, /writeReport:\s*true/);
  assert.match(reviewSrc, /createQualityReport/);
  assert.match(streamSrc, /writeReport:\s*true/);
  assert.match(streamSrc, /persistChapterQualityScores/);
});
