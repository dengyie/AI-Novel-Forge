const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PostGenerationStyleReviewRunner,
} = require("../dist/services/novel/runtime/PostGenerationStyleReviewRunner.js");
const {
  computeAntiAiClustering,
  applyClusteredRiskFloor,
} = require("../dist/services/styleEngine/StyleDetectionService.js");

// 集成测试：把 detection + 双轮改写 + 聚类兜底串成端到端控制流，用 mock LLM 产物验证
// "AI 味样本经双轮自审后 riskScore 递降、套词减少"这一核心闭环。不调真 LLM（真调走人工抽检）。

function contextPackageWithStyle() {
  return { styleContext: { compiledBlocks: { contract: {} } } };
}

function baseInput(content) {
  return {
    novelId: "novel-1",
    chapterId: "chapter-1",
    request: { taskStyleProfileId: null, provider: "test", model: "test", temperature: 0.5 },
    contextPackage: contextPackageWithStyle(),
    content,
  };
}

function violation(ruleName, excerpt) {
  return {
    ruleName,
    ruleType: "risk",
    severity: "medium",
    issueCategory: "style_expression",
    excerpt,
    reason: `${ruleName} 触发`,
    suggestion: "改成具体动作与现场信息",
    canAutoRewrite: true,
  };
}

// 一段刻意堆叠多类 AI 味的中文网文样本：呼吸驱动 + 弱化副词 + 定格收尾。
const AI_SAMPLE = [
  "他深吸一口气，缓缓抬起头，目光渐渐落在远处。",
  "风微微吹过，他的心跳渐渐平复下来，仿佛一切都慢了下来。",
  "他知道，这一刻终将到来。",
  "夜色深沉。",
  "而远方，有什么正在苏醒。",
].join("\n");

// 编排式 detection：模拟真实 LLM 对"改写前 vs 改写后"给出递降 riskScore。
function decliningDetection(scores) {
  let call = 0;
  const stub = {
    calls: 0,
    reports: [],
    check: async ({ content }) => {
      const riskScore = scores[Math.min(call, scores.length - 1)];
      call += 1;
      stub.calls = call;
      const rep = {
        riskScore,
        summary: `第${call}次检测`,
        canAutoRewrite: riskScore >= 35,
        appliedRuleIds: [],
        violations: riskScore >= 35
          ? [violation("risk-breath-driven-transition", "深吸一口气"), violation("risk-weak-adverb-mushroom", "缓缓")]
          : [],
      };
      stub.reports.push({ content, riskScore });
      return rep;
    },
  };
  return stub;
}

// 改写 stub：每轮"消掉"一类套词，模拟改写产物逐轮变干净。
function cleaningRewrite() {
  const stub = {
    calls: 0,
    rewrite: async ({ content }) => {
      stub.calls += 1;
      let next = content;
      if (stub.calls === 1) {
        next = content.replace(/深吸一口气，/g, "").replace(/缓缓/g, "");
      } else {
        next = content.replace(/渐渐/g, "").replace(/仿佛/g, "");
      }
      return { content: next };
    },
  };
  return stub;
}

test("端到端：AI 味样本经双轮自审改写，riskScore 递降且套词减少", async () => {
  const detection = decliningDetection([72, 55, 20]);
  const rewrite = cleaningRewrite();
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: {
      resolve: async () => ({ enabled: true, secondRoundEnabled: true, secondRoundThreshold: 50 }),
    },
  });

  const result = await runner.run(baseInput(AI_SAMPLE));

  // 首轮 72（≥35 触发改写），残留 55（≥50 触发二轮），二轮后 20。
  assert.equal(detection.calls, 2, "首轮检测 + 首轮改写后残留检测，共 2 次");
  assert.equal(rewrite.calls, 2, "应触发两轮改写");
  assert.equal(result.autoRewritten, true);
  // 最终产物应比原文短（套词被消掉）。
  assert.ok(result.finalContent.length < AI_SAMPLE.length, "改写后正文套词减少");
  // 首轮 report 的 riskScore 是入口分。
  assert.equal(result.report.riskScore, 72);
  // 残留检测分（第二次）低于首轮，验证 riskScore 递降趋势。
  assert.ok(detection.reports[1].riskScore < detection.reports[0].riskScore, "改写后残留 riskScore 应低于首轮");
});

test("端到端：残留低于二轮阈值时单轮收敛，不追加第二轮", async () => {
  const detection = decliningDetection([60, 30]);
  const rewrite = cleaningRewrite();
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: {
      resolve: async () => ({ enabled: true, secondRoundEnabled: true, secondRoundThreshold: 50 }),
    },
  });

  const result = await runner.run(baseInput(AI_SAMPLE));

  // 首轮 60 触发改写，残留 30 < 50 → 不进二轮。
  assert.equal(rewrite.calls, 1, "残留低于阈值只改一轮");
  assert.equal(result.autoRewritten, true);
});

test("聚类扫描能在样本上捕捉多类 AI 痕迹成簇", () => {
  // 用与新规则一致的字面量模式验证聚类判定在真实样本上生效。
  const rules = [
    { id: "r1", type: "risk", enabled: true, detectPatterns: ["深吸一口气"] },
    { id: "r2", type: "risk", enabled: true, detectPatterns: ["缓缓"] },
    { id: "r3", type: "risk", enabled: true, detectPatterns: ["渐渐"] },
    { id: "r4", type: "risk", enabled: true, detectPatterns: ["他知道"] },
  ];
  const clustering = computeAntiAiClustering(AI_SAMPLE, rules);
  assert.ok(clustering.clusteredHitCount >= 3, "样本命中多类套词");
  assert.equal(clustering.isClustered, true, "应判定为成簇");
  assert.equal(clustering.shouldSkipLlm, false, "成簇不应跳过 LLM");
  // 成簇兜底：即使 LLM 给低分，也抬到下限。
  assert.equal(applyClusteredRiskFloor(10, clustering.isClustered), 45);
});
