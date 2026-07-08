const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeAntiAiClustering,
  applyClusteredRiskFloor,
} = require("../dist/services/styleEngine/StyleDetectionService.js");

// 守卫：空 detectPatterns 的 risk 规则不参与字面量快扫聚类计数，确保"段落整齐/连续解释/
// 首先…最后"这类元描述或超高频逻辑词不会被误计入 clusteredHitCount，也不会因正文含"首先/然后"
// 让正常叙事被误判成簇。回归 fix/anti-ai-meta-detect-patterns 这条修复。

const RULE_FALSE_LITERAL = "forbid-explicit-psychology";
const RULE_WITH_PATTERNS = "risk-breath-driven-transition";
const RULE_META_EMPTY = "risk-even-paragraph-length";
const RULE_FREQ_EMPTY = "risk-repeated-sentence-structure";

function rulesFixture() {
  return [
    { id: RULE_FALSE_LITERAL, type: "forbidden", enabled: true, detectPatterns: ["他感到", "她感到"] },
    { id: RULE_WITH_PATTERNS, type: "risk", enabled: true, detectPatterns: ["深吸一口气"] },
    { id: RULE_META_EMPTY, type: "risk", enabled: true, detectPatterns: [] },
    { id: RULE_FREQ_EMPTY, type: "risk", enabled: true, detectPatterns: [] },
  ];
}

test("computeAntiAiClustering：空 detectPatterns 的 risk 规则不参与聚类计数", () => {
  // 正文含真实字面量命中 2 条不同规则，但两条空 detectPatterns 规则即便主题相关也不计数。
  const content = "他感到一阵寒意。深吸一口气，刀刃贴着头皮擦过去。";
  const result = computeAntiAiClustering(content, rulesFixture());
  assert.equal(result.clusteredHitCount, 2);
  assert.equal(result.isClustered, false);
});

test("computeAntiAiClustering：正常叙事含超高频逻辑词不被误判成簇", () => {
  // 修复前的 risk-repeated-sentence-structure detectPatterns=["首先","然后","接着","最后"]
  // 正常叙事几乎每章必中、必误判成簇。空 detectPatterns 后此类文本不再贡献聚类计数。
  const content = "首先他看了看四周。然后他走了出去。接着天黑了。最后什么也没发生。";
  const result = computeAntiAiClustering(content, rulesFixture());
  assert.equal(result.clusteredHitCount, 0);
  assert.equal(result.isClustered, false);
  assert.equal(result.shouldSkipLlm, true);
});

test("computeAntiAiClustering：≥3 条不同规则命中才成簇（humanizer clusters not isolated tells）", () => {
  const content = "他感到寒意，她感到恐惧，他心里清楚。深吸一口气。告诉你个秘密，我们现在要走，接下来就地解散。";
  const extra = [
    ...rulesFixture(),
    { id: "risk-dialogue-too-functional", type: "risk", enabled: true, detectPatterns: ["告诉你", "我们现在要", "接下来就"] },
  ];
  const result = computeAntiAiClustering(content, extra);
  assert.ok(result.clusteredHitCount >= 3, `expected >=3, got ${result.clusteredHitCount}`);
  assert.equal(result.isClustered, true);
});

test("applyClusteredRiskFloor：成簇且 LLM 有 violations 时抬到下限；无 violations 或非成簇不抬", () => {
  assert.equal(applyClusteredRiskFloor(20, true, true), 45);
  assert.equal(applyClusteredRiskFloor(20, true, false), 20);
  assert.equal(applyClusteredRiskFloor(80, true, true), 80);
  assert.equal(applyClusteredRiskFloor(20, false, true), 20);
  assert.equal(applyClusteredRiskFloor(120, true, true), 100);
});
