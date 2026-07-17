const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitNarrativeParagraphs,
  selectPronounHotspotParagraphs,
  stitchParagraphs,
  pickBetterStyleCandidate,
  scoreTextForHotspotPick,
  DEFAULT_HOTSPOT_MIN_RUN,
  DEFAULT_MAX_HOTSPOTS,
} = require("../dist/services/novel/runtime/styleReview/HotspotParagraphRewrite.js");
const {
  PostGenerationStyleReviewRunner,
} = require("../dist/services/novel/runtime/PostGenerationStyleReviewRunner.js");

test("DEFAULT 热点参数：minRun=3 maxHotspots=4", () => {
  assert.equal(DEFAULT_HOTSPOT_MIN_RUN, 3);
  assert.equal(DEFAULT_MAX_HOTSPOTS, 4);
});

test("splitNarrativeParagraphs：空行分段并保留 index/start/end", () => {
  const content = "第一段。\n\n第二段两句。还在。\n\n\n第三段。";
  const slices = splitNarrativeParagraphs(content);
  assert.equal(slices.length, 3);
  assert.equal(slices[0].index, 0);
  assert.equal(slices[0].text, "第一段。");
  assert.equal(slices[1].text, "第二段两句。还在。");
  assert.equal(slices[2].text, "第三段。");
  // start/end 可在原文切片回原文
  for (const slice of slices) {
    assert.equal(content.slice(slice.start, slice.end), slice.text);
  }
});

test("splitNarrativeParagraphs：单段无空行 → 一整段", () => {
  const content = "他坐下。他端杯。他没喝。";
  const slices = splitNarrativeParagraphs(content);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].text, content);
});

test("selectPronounHotspotParagraphs picks paragraph with run≥3", () => {
  const content = [
    "沈晚看了他一眼。\n\n",
    "他坐下。他端杯。他没喝。\n\n",
    "走廊里有人经过。",
  ].join("");
  const hits = selectPronounHotspotParagraphs(content, { minRun: 3 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /他坐下/);
});

test("selectPronounHotspotParagraphs：run 不足不入选", () => {
  const content = "他坐下。沈晚端杯。他没喝。\n\n走廊里有人经过。";
  const hits = selectPronounHotspotParagraphs(content, { minRun: 3 });
  assert.equal(hits.length, 0);
});

test("selectPronounHotspotParagraphs：maxHotspots 截断且优先长 run", () => {
  const p1 = "他走。他停。他看。"; // run 3
  const p2 = "他坐。他端。他喝。他起。"; // run 4
  const p3 = "他推。他开。他进。"; // run 3
  const content = [p1, p2, p3].join("\n\n");
  const hits = selectPronounHotspotParagraphs(content, { minRun: 3, maxHotspots: 2 });
  assert.equal(hits.length, 2);
  // 优先最长 run：p2 必须在内
  assert.ok(hits.some((h) => h.text.includes("他坐")));
});

test("stitchParagraphs preserves non-replaced segments", () => {
  const original = "A段。\n\nB段要改。\n\nC段。";
  const slices = splitNarrativeParagraphs(original);
  const b = slices.find((s) => s.text.includes("B段"));
  assert.ok(b);
  const stitched = stitchParagraphs(original, [{ index: b.index, text: "B段已改写。" }]);
  assert.match(stitched, /A段/);
  assert.match(stitched, /B段已改写/);
  assert.match(stitched, /C段/);
  assert.ok(!stitched.includes("B段要改"));
});

test("stitchParagraphs：未知 index 忽略", () => {
  const original = "仅一段。";
  const stitched = stitchParagraphs(original, [{ index: 99, text: "幽灵" }]);
  assert.equal(stitched, original);
});

test("pickBetterStyleCandidate discards worse candidate with new HUD", () => {
  const picked = pickBetterStyleCandidate({
    baseline: "他走进教室。",
    candidates: ["【系统】任务完成。他走进教室。", "何屿走进教室。"],
    score: (text) => ({
      riskScore: text.includes("【") ? 90 : text.includes("何屿") ? 10 : 40,
      blockingPronoun: /他走进/.test(text) && !text.includes("何屿"),
      lengthDelta: text.length - 6,
      hardRegression: text.includes("【"),
    }),
  });
  assert.match(picked.content, /何屿/);
  assert.equal(picked.adoptedIndex, 1);
});

test("pickBetterStyleCandidate：字数塌缩 <0.5 丢弃", () => {
  const baseline = "他走进教室。窗外雨声渐大。走廊尽头有人停步。";
  const picked = pickBetterStyleCandidate({
    baseline,
    candidates: ["他走。"],
    score: (text) => ({
      riskScore: 5,
      blockingPronoun: false,
      lengthDelta: text.length - baseline.length,
      hardRegression: false,
    }),
  });
  assert.equal(picked.content, baseline);
  assert.equal(picked.adoptedIndex, null);
});

test("pickBetterStyleCandidate：无改善保持 baseline", () => {
  const baseline = "他走进教室。";
  const picked = pickBetterStyleCandidate({
    baseline,
    candidates: ["他迈进教室。"],
    score: (text) => ({
      riskScore: 40,
      blockingPronoun: true,
      lengthDelta: 0,
      hardRegression: false,
    }),
  });
  assert.equal(picked.adoptedIndex, null);
  assert.equal(picked.content, baseline);
});

test("scoreTextForHotspotPick：stack 段 blockingPronoun=true", () => {
  const text = "他坐下。他端杯。他没喝。他起身。他推门。";
  const s = scoreTextForHotspotPick(text, text.length);
  assert.equal(s.blockingPronoun, true);
  assert.ok(s.riskScore > 0);
});

test("scoreTextForHotspotPick：HUD 触发 hardRegression", () => {
  const text = "【系统】任务完成\n他推开门。";
  const s = scoreTextForHotspotPick(text, 10);
  assert.equal(s.hardRegression, true);
  assert.ok(s.riskScore >= 80);
});

// --- Runner 集成（mock rewrite / detect）---

function contextPackageWithStyle() {
  return {
    styleContext: {
      compiledBlocks: { contract: {} },
    },
  };
}

function baseInput(overrides = {}) {
  return {
    novelId: "novel-1",
    chapterId: "chapter-1",
    request: { taskStyleProfileId: null, provider: "test", model: "test", temperature: 0.5 },
    contextPackage: contextPackageWithStyle(),
    content: "原始正文。",
    ...overrides,
  };
}

function report({ riskScore, canAutoRewrite = true, violations }) {
  return {
    riskScore,
    summary: "",
    canAutoRewrite,
    appliedRuleIds: [],
    violations: violations ?? [
      {
        ruleId: "l0:prose_pronoun_subject_stack",
        ruleName: "禁止句首第三人称代词堆叠",
        ruleType: "forbidden",
        severity: "high",
        issueCategory: "style_expression",
        excerpt: "他…",
        reason: "stack",
        suggestion: "改用专名或动作起句",
        canAutoRewrite: true,
      },
    ],
  };
}

function policyStub(policy = {}) {
  return {
    resolve: async () => ({
      enabled: true,
      secondRoundEnabled: false,
      secondRoundThreshold: 50,
      hotspotRewriteEnabled: true,
      ...policy,
    }),
  };
}

test("runner 热点路径：mock 改写专名后 autoRewritten，HUD 候选被丢", async () => {
  // 中间段 3×句首他 → hotspot；整章 risk 低不走 whole-chapter 首轮，仍走热点。
  const content = [
    "沈晚推开窗。潮气扑进来。",
    "他坐下。他端杯。他没喝。",
    "走廊里有人经过。灯还亮着。",
  ].join("\n\n");

  let rewriteCalls = 0;
  const rewrite = {
    rewrite: async ({ content: piece }) => {
      rewriteCalls += 1;
      // K=2：先给 HUD 毒丸，再给可采纳专名版
      if (rewriteCalls % 2 === 1) {
        return { content: `【系统】完成。${piece}` };
      }
      return {
        content: piece
          .replace(/^他/u, "何屿")
          .replace(/。他/gu, "。何屿"),
      };
    },
  };

  // detect：首轮低分不走 whole-chapter；热点后 residual 再检
  let detectCalls = 0;
  const detection = {
    check: async ({ content: c }) => {
      detectCalls += 1;
      if (detectCalls === 1) {
        return report({ riskScore: 20, canAutoRewrite: false, violations: [] });
      }
      // residual
      const stillStack = /(?:^|。|！|？)他/u.test(c) && (c.match(/他/g) || []).length >= 3;
      return report({
        riskScore: stillStack ? 55 : 12,
        violations: stillStack
          ? undefined
          : [],
        canAutoRewrite: stillStack,
      });
    },
  };

  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: policyStub({ secondRoundEnabled: false }),
  });

  const result = await runner.run(baseInput({ content }));
  assert.ok(rewriteCalls >= 2, "热点段落至少 K=2 次 paragraph rewrite");
  assert.equal(result.autoRewritten, true);
  assert.ok(!result.finalContent.includes("【系统】"), "HUD 候选不得采纳");
  assert.match(result.finalContent, /何屿/);
  assert.match(result.finalContent, /沈晚推开窗/);
  assert.match(result.finalContent, /走廊里有人经过/);
});

test("runner hotspotRewriteEnabled=false → 不调 paragraph rewrite", async () => {
  const content = "他坐下。他端杯。他没喝。\n\n走廊安静。";
  let rewriteCalls = 0;
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: {
      check: async () => report({ riskScore: 10, canAutoRewrite: false, violations: [] }),
    },
    styleRewriteService: {
      rewrite: async () => {
        rewriteCalls += 1;
        return { content: "不应调用" };
      },
    },
    postGenerationStyleReviewPolicyResolver: policyStub({
      secondRoundEnabled: false,
      hotspotRewriteEnabled: false,
    }),
  });
  const result = await runner.run(baseInput({ content }));
  assert.equal(rewriteCalls, 0);
  assert.equal(result.autoRewritten, false);
  assert.equal(result.finalContent, content);
});
