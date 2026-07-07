// 真 LLM 端到端抽检：验证 humanizer 去 AI 味体系在真实 deepseek 调用下的效果。
// 不进 CI（依赖 .env 的 DEEPSEEK_API_KEY + 真实 LLM，成本&非确定性）。
// 用法：cd server && node scripts/manual-humanizer-smoke.cjs
require("dotenv").config();

const { StyleDetectionService } = require("../dist/services/styleEngine/StyleDetectionService.js");
const { StyleRewriteService } = require("../dist/services/styleEngine/StyleRewriteService.js");

// 挑一个默认 profile（走 styleProfileId 直连路径，无需 novel binding）。
const STYLE_PROFILE_ID = "cmr9o71c5000trrthy8bbyokv"; // 我的默认爽文推进写法

// 3 段刻意堆叠多类 AI 味的中文网文样本（呼吸驱动/弱化副词/定格收尾/比喻套话/权威腔）。
const SAMPLES = [
  {
    label: "样本1·呼吸+弱化副词+定格收尾",
    text: [
      "他深吸一口气，缓缓抬起头，目光渐渐落在远处的山脊上。",
      "风微微吹过，他的心跳渐渐平复下来，仿佛一切都慢了下来，仿佛时间在这一刻凝固。",
      "他知道，这一刻终将到来。",
      "夜色深沉。",
      "而远方，有什么正在悄然苏醒。",
    ].join("\n"),
  },
  {
    label: "样本2·比喻套话+权威腔+三段排比",
    text: [
      "她的眼睛像是深不见底的湖水，仿佛藏着说不尽的故事，宛如一幅精心雕琢的画卷。",
      "真正重要的是，他必须做出选择：是战斗，是逃跑，还是妥协。",
      "本质上，这不是一场战争，而是一次觉醒。",
      "他缓缓握紧了拳头，指节微微发白。",
    ].join("\n"),
  },
  {
    label: "样本3·全知旁白+段尾升华",
    text: [
      "他意识到自己已经无路可退，他明白了命运的安排。",
      "少年缓缓站起身，男人的目光扫过全场，主角的嘴角渐渐扬起一抹微笑。",
      "归根结底，人总要学会成长，这就是生活教给他的道理。",
    ].join("\n"),
  },
];

// 套词频次统计（粗粒度，用于人工对比改写前后）。
const TELLS = ["深吸一口气", "缓缓", "渐渐", "微微", "仿佛", "像是", "宛如", "他知道", "真正重要的是", "本质上", "归根结底", "这就是"];
function countTells(text) {
  let total = 0;
  const hits = [];
  for (const t of TELLS) {
    const n = text.split(t).length - 1;
    if (n > 0) { total += n; hits.push(`${t}×${n}`); }
  }
  return { total, hits };
}

async function main() {
  const detection = new StyleDetectionService();
  const rewrite = new StyleRewriteService();

  for (const sample of SAMPLES) {
    console.log("\n" + "=".repeat(70));
    console.log(sample.label);
    console.log("=".repeat(70));

    const before = countTells(sample.text);
    console.log(`\n[原文] 套词 ${before.total} 处: ${before.hits.join(", ")}`);

    // 首轮真实检测。
    const r1 = await detection.check({ content: sample.text, styleProfileId: STYLE_PROFILE_ID, temperature: 0.2 });
    console.log(`\n[首轮检测] riskScore=${r1.riskScore}  violations=${r1.violations.length}  canAutoRewrite=${r1.canAutoRewrite}`);
    for (const v of r1.violations.slice(0, 6)) {
      console.log(`  - ${v.ruleName} [${v.severity}] 「${v.excerpt}」`);
    }

    const rewritable = r1.violations.filter((v) => v.canAutoRewrite && v.suggestion.trim());
    if (r1.riskScore < 35 || rewritable.length === 0) {
      console.log("\n[跳过改写] 未达首轮阈值或无可改写项。");
      continue;
    }

    // 首轮改写。
    const w1 = await rewrite.rewrite({
      content: sample.text,
      styleProfileId: STYLE_PROFILE_ID,
      issues: rewritable.map((v) => ({ ruleName: v.ruleName, excerpt: v.excerpt, suggestion: v.suggestion })),
      temperature: 0.5,
    });
    const after = countTells(w1.content);
    console.log(`\n[首轮改写产物]\n${w1.content}`);
    console.log(`\n[改写后] 套词 ${after.total} 处: ${after.hits.join(", ") || "无"}`);

    // 残留检测（验证 riskScore 递降）。
    const r2 = await detection.check({ content: w1.content, styleProfileId: STYLE_PROFILE_ID, temperature: 0.2 });
    console.log(`\n[残留检测] riskScore=${r2.riskScore}  violations=${r2.violations.length}`);

    // 汇总。
    const scoreDelta = r1.riskScore - r2.riskScore;
    const tellDelta = before.total - after.total;
    console.log(`\n>>> riskScore ${r1.riskScore} → ${r2.riskScore} (${scoreDelta >= 0 ? "降" : "升"}${Math.abs(scoreDelta)})  |  套词 ${before.total} → ${after.total} (${tellDelta >= 0 ? "减" : "增"}${Math.abs(tellDelta)})`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("抽检完成。人工判断：riskScore 是否递降、套词是否减少、改写产物可读性有无下降。");
}

main().then(() => process.exit(0)).catch((e) => { console.error("抽检失败:", e); process.exit(1); });
