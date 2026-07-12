const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inferGenreBeatWeights,
  hasGenreFramingSignal,
  buildGenreBeatQuotaTargets,
  classifyGenreBeatFromText,
  evaluateGenreBeatCoverage,
  jaccardBiGramSimilarity,
  shouldForceSceneDiversity,
  buildSceneDiversityForceDirective,
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
  assert.equal(hasGenreFramingSignal({
    sellingPoint: "轻松养成与资源收集",
  }), true);
});

test("empty or keyword-less framing does not enforce primary mins (product B)", () => {
  const emptyWeights = inferGenreBeatWeights({});
  assert.equal(hasGenreFramingSignal({}), false);
  assert.equal(hasGenreFramingSignal(null), false);
  assert.equal(hasGenreFramingSignal({ sellingPoint: "   " }), false);
  assert.equal(hasGenreFramingSignal({ sellingPoint: "一部关于勇气的故事" }), false);
  for (const kind of Object.keys(emptyWeights)) {
    assert.equal(emptyWeights[kind], 0, `empty framing weight ${kind} must be 0`);
  }

  const weakWeights = inferGenreBeatWeights({
    sellingPoint: "一部关于勇气的故事",
    competingFeel: "独创叙事",
    first30ChapterPromise: "前三十章建立世界观",
  });
  for (const kind of Object.keys(weakWeights)) {
    assert.equal(weakWeights[kind], 0);
  }

  const emptyTargets = buildGenreBeatQuotaTargets({
    windowSize: 30,
    framing: {},
  });
  assert.equal(emptyTargets.length, 0, "no framing signal → no min targets");

  const weakTargets = buildGenreBeatQuotaTargets({
    windowSize: 30,
    framing: { sellingPoint: "一部关于勇气的故事" },
  });
  assert.equal(weakTargets.length, 0);

  // 满窗全 combat：旧默认养成配额会 meetsPrimary=false 并 pause；现应不 enforce
  const combatOnly = Array.from({ length: 30 }, () => "combat");
  const coverage = evaluateGenreBeatCoverage({
    chapterLabels: combatOnly,
    windowSize: 30,
    framing: {},
  });
  assert.equal(coverage.windowProgress, "complete");
  assert.equal(coverage.targets.length, 0);
  assert.equal(coverage.shortfalls.length, 0);
  assert.equal(coverage.meetsPrimaryQuota, true, "empty framing must not fail primary quota");
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
  assert.equal(result.windowProgress, "complete");
  assert.equal(result.labeledChapterCount, 30);
  assert.ok(result.shortfalls.some((item) => item.kind === "nurture" || item.kind === "collect"));
  assert.equal(result.meetsPrimaryQuota, false);
  for (const item of result.shortfalls) {
    assert.equal(item.expectedMin, item.fullWindowExpectedMin);
  }
});

test("incomplete window uses progress expectedMin not full-window min", () => {
  const framing = {
    sellingPoint: "轻松养成与资源收集",
    first30ChapterPromise: "前三十章稳定养成与收集反馈",
  };
  // 5 combat-only chapters in a 30-window: progress expected is small, not 0/10 full-window debt
  const combatOnly = evaluateGenreBeatCoverage({
    chapterLabels: Array.from({ length: 5 }, () => "combat"),
    windowSize: 30,
    framing,
  });
  assert.equal(combatOnly.windowProgress, "in_progress");
  assert.equal(combatOnly.labeledChapterCount, 5);
  assert.ok(combatOnly.shortfalls.length > 0);
  for (const item of combatOnly.shortfalls) {
    assert.ok(item.expectedMin <= item.fullWindowExpectedMin);
    assert.ok(item.expectedMin <= 5);
    assert.ok(item.fullWindowExpectedMin >= item.expectedMin);
  }
  assert.equal(combatOnly.meetsPrimaryQuota, false);

  // even split meets progress expectedMin (ceil(n * ratio)); 6 章 3/3 → 各 expectedMin=3
  const balanced = evaluateGenreBeatCoverage({
    chapterLabels: ["nurture", "collect", "nurture", "collect", "nurture", "collect"],
    windowSize: 30,
    framing,
  });
  assert.equal(balanced.windowProgress, "in_progress");
  assert.equal(balanced.meetsPrimaryQuota, true);
  assert.equal(balanced.shortfalls.length, 0);
  // 满窗绝对下限仍保留在 targets / fullWindowExpectedMin
  assert.ok(balanced.targets.every((t) => t.minChapters === 15));
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

test("buildSceneDiversityForceDirective injects soft constraints only when shouldForce", () => {
  const repeated = "城门逃亡雨夜追兵压迫再逃亡";
  const forced = buildSceneDiversityForceDirective({
    recentTexts: [repeated, repeated, repeated, repeated, repeated],
    window: 5,
    threshold: 0.55,
  });
  assert.equal(forced.shouldForce, true);
  assert.equal(forced.advisory, true);
  assert.ok(forced.riskNotes.some((item) => item.includes("scene_diversity_force")));
  assert.ok(forced.riskNotes.some((item) => item.includes("禁止复用")));
  assert.ok(forced.scenePatterns.length >= 1);
  assert.ok(forced.summaryLine && forced.summaryLine.includes("换场景软约束"));
  // 软约束不得暴露 doNotCross 字段，避免误入 forbiddenCrossings
  assert.equal(Object.prototype.hasOwnProperty.call(forced, "doNotCross"), false);

  const idle = buildSceneDiversityForceDirective({
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
  assert.equal(idle.shouldForce, false);
  assert.equal(idle.advisory, true);
  assert.deepEqual(idle.riskNotes, []);
  assert.deepEqual(idle.scenePatterns, []);
  assert.equal(idle.summaryLine, null);
});
