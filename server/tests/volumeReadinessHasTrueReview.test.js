const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasTrueReviewMarker,
} = require("../dist/services/novel/volume/volumeReadinessSignals.js");

test("evaluatedAt alone is NOT true review", () => {
  assert.equal(hasTrueReviewMarker({
    evaluatedAt: new Date().toISOString(),
    signals: [{ artifactType: "prose_quality", status: "valid" }],
  }), false);
});

test("literary_score marks true review", () => {
  assert.equal(hasTrueReviewMarker({
    signals: [{ artifactType: "literary_score", status: "valid" }],
  }), true);
});

test("style_residual marks true review", () => {
  assert.equal(hasTrueReviewMarker({
    signals: [{ artifactType: "style_residual", status: "valid" }],
  }), true);
});

test("null / empty → false", () => {
  assert.equal(hasTrueReviewMarker(null), false);
  assert.equal(hasTrueReviewMarker({}), false);
  assert.equal(hasTrueReviewMarker({ signals: [] }), false);
});
