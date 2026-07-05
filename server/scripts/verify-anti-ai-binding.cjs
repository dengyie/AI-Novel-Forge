// 验证绑定生效: 跑 StyleRuntimeResolver.resolve({novelId}) 看返回 antiAiRules 是否含新 7 条。
const { StyleRuntimeResolver } = require("../dist/services/styleEngine/StyleRuntimeResolver.js");

const NOVEL_ID = "cmqpuqmh7000999thodn0c53u";
const EXPECTED_KEYS = [
  "forbid-signature-eye-cliche",
  "risk-tail-flick-cliche",
  "risk-deep-breath-transition",
  "risk-weak-adverb-mushroom",
  "risk-even-simile",
  "risk-freeze-frame-ending",
  "risk-omniscient-aside",
];

async function main() {
  try {
    const resolver = new StyleRuntimeResolver();
    const { antiAiRules, primaryProfile } = await resolver.resolve({ novelId: NOVEL_ID });
    console.log("primaryProfile:", primaryProfile ? `${primaryProfile.id} | ${primaryProfile.name}` : "null");
    console.log(`antiAiRules 生效总数: ${antiAiRules.length}`);
    const keys = antiAiRules.map((r) => r.key);
    const missing = EXPECTED_KEYS.filter((k) => !keys.includes(k));
    const present = EXPECTED_KEYS.filter((k) => keys.includes(k));
    console.log(`\n期望 7 条命中: ${present.length}/7`);
    if (missing.length > 0) {
      console.log("缺失:", missing);
    } else {
      console.log("✅ 全部生效");
    }
    console.log("\n生效规则 key 列表:");
    for (const k of keys) console.log("  " + k);
  } catch (err) {
    console.error("验证失败:", err);
    process.exitCode = 1;
  }
}

main();
