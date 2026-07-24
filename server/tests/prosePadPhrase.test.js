const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectProseQuality,
  countPadPhraseHits,
} = require("../dist/services/novel/runtime/proseQuality/ProseQualityDetector.js");

const {
  extractPadHitCountFromQualityLoop,
  buildQualityDebtBoardItem,
} = require("../dist/services/novel/quality/qualityDebtBoard.js");

test("countPadPhraseHits counts 就在这时 and peers", () => {
  const text = [
    "就在这时门开了。",
    "就在这时他抬起头。",
    "与此同时走廊尽头有人影。",
    "她深吸一口气，继续往前。",
    "正常叙述句不受影响。",
  ].join("\n");
  const summary = countPadPhraseHits(text);
  assert.ok(summary.totalHits >= 4, `expected ≥4 hits, got ${summary.totalHits}`);
  const jzt = summary.byPhrase.find((item) => item.phrase === "就在这时");
  assert.ok(jzt);
  assert.equal(jzt.count, 2);
});

test("detectProseQuality emits prose_pad_phrase at medium below hard threshold", () => {
  // soft pad density: a few 就在这时；句身各异，避免 verbatim_repeat 误抬 blocking
  const tails = [
    "门轴轻轻响了一声。",
    "窗外掠过一道车灯。",
    "他捏紧口袋里的纸条。",
    "远处传来两声犬吠。",
    "楼道灯泡跳了跳。",
    "她把伞挂回钩上。",
  ];
  const body = tails.map((tail) => `就在这时，${tail}`).join("\n");
  const report = detectProseQuality(body, {
    pad: {
      phrases: ["就在这时"],
      softThreshold: 3,
      hardThreshold: 20,
      maxLocationsPerPhrase: 4,
    },
  });
  const padFindings = report.findings.filter((f) => f.code === "prose_pad_phrase");
  assert.ok(padFindings.length >= 1, "should emit pad findings");
  assert.ok(padFindings.every((f) => f.severity === "medium"));
  // 其它 code 可能仍有 medium；本断言只要求 pad 未抬 high/critical
  assert.equal(padFindings.some((f) => f.severity === "high" || f.severity === "critical"), false);
});

test("detectProseQuality elevates pad to high at hard threshold", () => {
  const body = Array.from({ length: 22 }, () => "就在这时，风从窗缝里钻进来。").join("\n");
  const report = detectProseQuality(body, {
    pad: {
      phrases: ["就在这时"],
      softThreshold: 5,
      hardThreshold: 20,
      maxLocationsPerPhrase: 3,
    },
  });
  const padFindings = report.findings.filter((f) => f.code === "prose_pad_phrase");
  assert.ok(padFindings.length >= 1);
  assert.ok(padFindings.some((f) => f.severity === "high"));
  assert.equal(report.hasBlockingFindings, true);
});

test("extractPadHitCountFromQualityLoop reads metrics and codes", () => {
  const fromMetrics = extractPadHitCountFromQualityLoop({
    signals: [{
      artifactType: "prose_quality",
      status: "risk",
      issueCodes: ["prose_pad_phrase"],
      metrics: { padHitCount: 17 },
    }],
  });
  assert.equal(fromMetrics, 17);

  const fromCodes = extractPadHitCountFromQualityLoop({
    signals: [{
      artifactType: "prose_quality",
      issueCodes: ["prose_pad_phrase", "prose_pad_phrase", "prose_long_paragraph"],
    }],
  });
  assert.equal(fromCodes, 2);

  assert.equal(extractPadHitCountFromQualityLoop(null), null);
});

test("quality debt board projects padHitCount override", () => {
  const item = buildQualityDebtBoardItem({
    id: "c1",
    order: 7,
    title: "垫长章",
    generationState: "reviewed",
    chapterStatus: "pending_review",
    padHitCountOverride: 18,
    riskFlags: JSON.stringify({
      qualityLoop: {
        overallStatus: "risk",
        recommendedAction: "patch_repair",
        rootCauseCode: "style_debt",
        evaluatedAt: "2026-07-23T00:00:00.000Z",
        signals: [],
      },
    }),
  });
  assert.ok(item);
  assert.equal(item.padHitCount, 18);
});
