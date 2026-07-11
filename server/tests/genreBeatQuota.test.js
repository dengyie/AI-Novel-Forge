const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inferGenreBeatWeights,
  buildGenreBeatQuotaTargets,
  classifyGenreBeatFromText,
  evaluateGenreBeatCoverage,
  jaccardBiGramSimilarity,
  shouldForceSceneDiversity,
} = require("../../shared/dist/types/genreBeatQuota.js");

test("inferGenreBeatWeights boosts nurture/collect for cozy framing", () => {
  const weights = inferGenreBeatWeights({
    sellingPoint: "轻松养成与资源收集",
    competingFeel: "日常成长 + 打宝",
    first30ChapterPromise: "前三十章稳定养成与收集反馈",
  });
  assert.ok(weights.nurture > 0.2);
  assert.ok(weights.collect > 0.15);
  assert.ok(weights.nurture + weights.collect > weights.combat);
});

test("buildGenreBeatQuotaTargets enforces min chapters in window", () => {
  const targets = buildGenreBeatQuotaTargets({
    windowSize: 30,
    framing: {
      sellingPoint: "轻松养成",
      first30ChapterPromise: "养成与收集",
    },
  });
  assert.ok(targets.length >= 1);
  const nurture = targets.find((item) => item.kind === "nurture");
  assert.ok(nurture);
  assert.ok(nurture.minChapters >= 1);
  assert.ok(nurture.minChapters <= 30);
});

test("evaluateGenreBeatCoverage reports shortfalls and primary quota", () => {
  const labels = Array.from({ length: 30 }, (_, index) => (
    index < 20 ? "combat" : "transition"
  ));
  const result = evaluateGenreBeatCoverage({
    chapterLabels: labels,
    windowSize: 30,
    framing: {
      sellingPoint: "轻松养成与收集",
      first30ChapterPromise: "前三十章养成收集",
    },
  });
  assert.equal(result.counts.combat, 20);
  assert.ok(result.shortfalls.some((item) => item.kind === "nurture" || item.kind === "collect"));
  assert.equal(result.meetsPrimaryQuota, false);
});

test("classifyGenreBeatFromText basic mapping", () => {
  assert.equal(classifyGenreBeatFromText("雨夜和解，重建羁绊"), "nurture");
  assert.equal(classifyGenreBeatFromText("巷口伏击，反杀追兵"), "combat");
  assert.equal(classifyGenreBeatFromText("遗迹探索发现新线索"), "explore");
});

test("rolling jaccard forces scene diversity when near-duplicate", () => {
  const repeated = "城门逃亡雨夜追兵压迫再逃亡";
  const force = shouldForceSceneDiversity({
    recentTexts: [repeated, repeated, repeated, repeated, repeated],
    window: 5,
    threshold: 0.55,
  });
  assert.equal(force.shouldForce, true);
  assert.ok(force.averageJaccard >= 0.55);

  const diverse = shouldForceSceneDiversity({
    recentTexts: [
      "雨夜和解重建羁绊",
      "遗迹探索发现地图",
      "坊市收集灵石图纸",
      "巷口伏击反杀追兵",
      "山道休整整备干粮",
    ],
    window: 5,
    threshold: 0.55,
  });
  assert.equal(diverse.shouldForce, false);
  assert.ok(jaccardBiGramSimilarity("abc", "xyz") < 0.2);
});
