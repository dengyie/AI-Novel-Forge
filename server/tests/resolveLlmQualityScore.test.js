const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasUsableQualityScore,
  resolveLlmQualityScore,
  normalizeScore,
  ruleScore,
} = require("../dist/services/novel/novelP0Utils.js");

const SAMPLE = "悬念。危机。冲突。转折。".repeat(80); // 足够长，ruleScore overall 不会落在 20

test("normalizeScore({}) is exactly overall=20 (silent-20 trap)", () => {
  const s = normalizeScore({});
  assert.equal(s.coherence, 0);
  assert.equal(s.repetition, 100);
  assert.equal(s.pacing, 0);
  assert.equal(s.voice, 0);
  assert.equal(s.engagement, 0);
  assert.equal(s.overall, 20);
});

test("hasUsableQualityScore rejects null/undefined/empty object", () => {
  assert.equal(hasUsableQualityScore(null), false);
  assert.equal(hasUsableQualityScore(undefined), false);
  assert.equal(hasUsableQualityScore({}), false);
  assert.equal(hasUsableQualityScore({ coherence: "high" }), false);
  assert.equal(hasUsableQualityScore({ overall: Number.NaN }), false);
});

test("hasUsableQualityScore accepts any finite dimension", () => {
  assert.equal(hasUsableQualityScore({ overall: 81 }), true);
  assert.equal(hasUsableQualityScore({ coherence: 0 }), true); // 0 也是合法数
  assert.equal(hasUsableQualityScore({ repetition: 100, pacing: 50 }), true);
});

test("resolveLlmQualityScore: empty/missing → ruleScore + degraded (never silent 20)", () => {
  for (const bad of [null, undefined, {}, { overall: "x" }]) {
    const r = resolveLlmQualityScore(bad, SAMPLE);
    assert.equal(r.degraded, true, `expected degraded for ${JSON.stringify(bad)}`);
    assert.notEqual(r.score.overall, 20, "must not emit silent overall=20");
    // ruleScore for non-empty content sits well above silent-20 (floor ~60-ish)
    assert.ok(r.score.overall >= 50, `ruleScore floor, got ${r.score.overall}`);
    const expected = ruleScore(SAMPLE);
    assert.deepEqual(r.score, expected);
  }
});

test("resolveLlmQualityScore: usable partial → normalize, not degraded", () => {
  const r = resolveLlmQualityScore({ overall: 81, coherence: 70 }, SAMPLE);
  assert.equal(r.degraded, false);
  assert.equal(r.score.overall, 81);
  assert.equal(r.score.coherence, 70);
  // missing dims still filled by normalizeScore defaults (not the C4 bug path — overall was present)
  assert.equal(r.score.repetition, 100);
});
