const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeAntiAiClustering,
  applyClusteredRiskFloor,
} = require("../dist/services/styleEngine/StyleDetectionService.js");
const {
  buildVoiceProfileText,
} = require("../dist/services/styleEngine/StyleRewriteService.js");

function rule(id, type, patterns) {
  return { id, type, enabled: true, detectPatterns: patterns };
}

// ============ 聚类判定 computeAntiAiClustering ============

test("forbidden 有字面量但 0 命中且未成簇 → 短路跳过 LLM", () => {
  const rules = [
    rule("f1", "forbidden", ["他感到", "他意识到"]),
    rule("r1", "risk", ["深吸一口气"]),
  ];
  const result = computeAntiAiClustering("他站在原地，看着远处的火光。", rules);
  assert.equal(result.hasForbiddenLiteralHit, false);
  assert.equal(result.isClustered, false);
  assert.equal(result.shouldSkipLlm, true);
});

test("forbidden 命中 1 个即走 LLM（硬违禁单点也查）", () => {
  const rules = [
    rule("f1", "forbidden", ["他感到"]),
  ];
  const result = computeAntiAiClustering("他感到一阵眩晕。", rules);
  assert.equal(result.hasForbiddenLiteralHit, true);
  assert.equal(result.shouldSkipLlm, false);
});

test("命中 3 个不同规则 → 成簇，即使无 forbidden 命中也走 LLM", () => {
  // 关键回归：整章各套一种 tell（深吸气 + 权威腔 + 负向排比），此前各 1 次不触发，现聚类升级。
  const rules = [
    rule("f1", "forbidden", ["他感到"]), // 不命中
    rule("r1", "risk", ["深吸一口气"]),
    rule("r2", "risk", ["真正重要的是"]),
    rule("r3", "risk", ["不是"]),
  ];
  const content = "他深吸一口气。真正重要的是活下去，这不是逃避。";
  const result = computeAntiAiClustering(content, rules);
  assert.equal(result.hasForbiddenLiteralHit, false);
  assert.equal(result.clusteredHitCount, 3);
  assert.equal(result.isClustered, true);
  assert.equal(result.shouldSkipLlm, false); // 成簇 → 不短路
});

test("命中 2 个不同规则 → 未达阈值，不成簇", () => {
  const rules = [
    rule("r1", "risk", ["深吸一口气"]),
    rule("r2", "risk", ["真正重要的是"]),
    rule("f1", "forbidden", ["他感到"]),
  ];
  const content = "他深吸一口气。真正重要的是活下去。";
  const result = computeAntiAiClustering(content, rules);
  assert.equal(result.clusteredHitCount, 2);
  assert.equal(result.isClustered, false);
});

test("含正则元字符的 pattern 不参与字面量扫描", () => {
  const rules = [
    rule("r1", "risk", ["(.*)复杂正则"]),
    rule("r2", "risk", ["深吸一口气"]),
  ];
  const result = computeAntiAiClustering("他深吸一口气。", rules);
  assert.equal(result.clusteredHitCount, 1); // 只有 r2 的字面量命中
});

test("disabled 规则不参与扫描", () => {
  const rules = [
    { id: "r1", type: "risk", enabled: false, detectPatterns: ["深吸一口气"] },
    rule("r2", "risk", ["真正重要的是"]),
    rule("r3", "risk", ["不是"]),
  ];
  const content = "他深吸一口气。真正重要的是活下去，这不是逃避。";
  const result = computeAntiAiClustering(content, rules);
  // r1 disabled 不算，只 r2+r3 命中 = 2，不成簇
  assert.equal(result.clusteredHitCount, 2);
  assert.equal(result.isClustered, false);
});

// ============ 聚类兜底 applyClusteredRiskFloor ============

test("成簇且有 violations 时 LLM 低分被抬到聚类下限 45", () => {
  assert.equal(applyClusteredRiskFloor(20, true, true), 45);
  assert.equal(applyClusteredRiskFloor(0, true, true), 45);
});

test("成簇但 LLM 判定文本干净（0 violations）→ 不抬分（P1 回归守卫）", () => {
  // 3 个字面量作为常用词合法出现使 isClustered=true，但 LLM 报 0 violations，
  // 说明文本其实干净——此时不应抬到 45，否则自相矛盾并触发无谓改写。
  assert.equal(applyClusteredRiskFloor(0, true, false), 0);
  assert.equal(applyClusteredRiskFloor(20, true, false), 20);
});

test("成簇时 LLM 高分不被压低", () => {
  assert.equal(applyClusteredRiskFloor(80, true, true), 80);
});

test("未成簇时 LLM 分数原样（clamp 到 0-100）", () => {
  assert.equal(applyClusteredRiskFloor(20, false, true), 20);
  assert.equal(applyClusteredRiskFloor(150, false, true), 100);
  assert.equal(applyClusteredRiskFloor(-5, false, true), 0);
});

// ============ Voice Calibration buildVoiceProfileText ============

test("profile 为 null → 返回 undefined（回退纯去 AI 味）", () => {
  assert.equal(buildVoiceProfileText(null), undefined);
});

test("profile 有 language/rhythm/narrative rules → 构建摘要", () => {
  const profile = {
    id: "p1",
    name: "测试文风",
    languageRules: { summary: "短句为主", register: "口语", roughness: 0.7 },
    rhythmRules: { summary: "快节奏", pace: "fast" },
    narrativeRules: { endingStyle: "留悬念" },
  };
  const text = buildVoiceProfileText(profile);
  assert.match(text, /短句为主/);
  assert.match(text, /口语/);
  assert.match(text, /0\.7/);
  assert.match(text, /快节奏/);
  assert.match(text, /留悬念/);
});

test("profile rules 全空 → 返回 undefined", () => {
  const profile = {
    id: "p1",
    name: "空文风",
    languageRules: {},
    rhythmRules: {},
    narrativeRules: {},
  };
  assert.equal(buildVoiceProfileText(profile), undefined);
});

test("profile rules 缺失字段 → 只输出存在的字段", () => {
  const profile = {
    id: "p1",
    name: "部分文风",
    languageRules: { register: "书面" },
    rhythmRules: undefined,
    narrativeRules: undefined,
  };
  const text = buildVoiceProfileText(profile);
  assert.match(text, /书面/);
  assert.doesNotMatch(text, /节奏/);
});
