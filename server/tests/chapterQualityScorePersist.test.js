const test = require("node:test");
const assert = require("node:assert/strict");

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
