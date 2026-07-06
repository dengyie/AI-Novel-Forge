// Phase 1 验证：seed 新增的 9 条通用中文网文 AI tell 规则是否落库 + globalBaseline 生效
const { seedStyleEngineStarterData } = require("../dist/services/bootstrap/SystemResourceBootstrapService.js");
const { prisma } = require("../dist/db/prisma.js");

const NEW_KEYS = [
  "risk-breath-driven-transition",
  "risk-freeze-frame-ending",
  "risk-weak-adverb-mushroom",
  "risk-simile-overuse",
  "risk-rule-of-three",
  "risk-elegant-variation",
  "risk-authority-trope",
  "risk-negative-parallelism",
  "risk-punctuation-driven-emotion",
];

async function main() {
  const report = await seedStyleEngineStarterData("missing_only");
  console.log("seed report:", JSON.stringify(report));

  const rows = await prisma.antiAiRule.findMany({
    where: { key: { in: NEW_KEYS } },
    select: { key: true, type: true, severity: true, enabled: true, globalBaselineEnabled: true, detectPatternsJson: true },
    orderBy: { key: "asc" },
  });

  console.log(`\n新规则落库: ${rows.length}/${NEW_KEYS.length}`);
  for (const r of rows) {
    const patterns = JSON.parse(r.detectPatternsJson || "[]");
    console.log(`  ${r.key} | ${r.type}/${r.severity} | enabled=${r.enabled} | global=${r.globalBaselineEnabled} | patterns=${patterns.length}`);
  }

  const missing = NEW_KEYS.filter((k) => !rows.some((r) => r.key === k));
  const allGlobal = rows.every((r) => r.globalBaselineEnabled === true);
  const allEnabled = rows.every((r) => r.enabled === true);

  // 扩展的 forbid-explicit-psychology 新增全知旁白句式
  const psych = await prisma.antiAiRule.findUnique({
    where: { key: "forbid-explicit-psychology" },
    select: { detectPatternsJson: true },
  });
  const psychPatterns = JSON.parse(psych?.detectPatternsJson || "[]");
  const hasOmniscient = ["他知道", "她知道", "他清楚", "他明白"].every((p) => psychPatterns.includes(p));

  console.log(`\n=== 验证结论 ===`);
  console.log(`缺失: ${missing.length === 0 ? "无 ✅" : missing.join(",")}`);
  console.log(`全部 globalBaseline: ${allGlobal ? "是 ✅" : "否 ❌"}`);
  console.log(`全部 enabled: ${allEnabled ? "是 ✅" : "否 ❌"}`);
  console.log(`forbid-explicit-psychology 扩展全知旁白: ${hasOmniscient ? "是 ✅" : "否 ❌"} (patterns=${psychPatterns.length})`);

  const pass = missing.length === 0 && allGlobal && allEnabled && hasOmniscient;
  console.log(`\n${pass ? "✅ Phase 1 seed 验证通过" : "❌ 验证失败"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("验证失败:", e); process.exit(1); });
