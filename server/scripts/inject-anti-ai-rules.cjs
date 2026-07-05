// 给小说 cmqpuqmh7000999thodn0c53u 注入针对性 anti-AI 规则 + 绑定专属 StyleProfile。
// 纯 DB 事务, 不触发 LLM。续写下一章立即读到 (resolveForGeneration 每次现查 DB, 无缓存)。
// 不动 default profile, 不在 DEFAULT_STARTER_STYLE_PROFILES 里 => sync_existing seed 永不波及。
// 用项目已有的 dist/db/prisma 实例 (Prisma 7.x 不可裸 new PrismaClient())。
const { prisma } = require("../dist/db/prisma.js");

const NOVEL_ID = "cmqpuqmh7000999thodn0c53u";

const RULES = [
  {
    key: "forbid-signature-eye-cliche",
    name: "灵兽眼神套路词",
    type: "forbidden",
    severity: "high",
    description: "禁用「琥珀色的眼睛」等已套化的灵兽眼神固定描写, 改用具体行为或新视觉词。",
    detectPatterns: ["琥珀色的眼睛", "琥珀色眼睛"],
    rewriteSuggestion: "用凝视方向、眨眼频率、瞳孔形态变化或环境映照替代固定眼神套词。",
    promptInstruction: "禁用「琥珀色的眼睛」「琥珀色眼睛」这类已用 40+ 章的套词描写灵兽眼神; 改写具体行为: 视线落点、眨眼频率、瞳孔形态、或环境在其瞳孔里的映照。",
    autoRewrite: true,
  },
  {
    key: "risk-tail-flick-cliche",
    name: "灵兽尾巴套路",
    type: "risk",
    severity: "medium",
    description: "灵兽情绪避免用「尾尖忽明忽暗」「尾尖微微颤抖」等已套化表达。",
    detectPatterns: ["尾尖.{0,6}忽明忽暗", "尾尖.{0,6}微微颤抖"],
    rewriteSuggestion: "灵兽情绪改用肢体位移、发声、姿态变化、尾巴整体动作描写。",
    promptInstruction: "灵兽情绪不要靠「尾尖忽明忽暗」「尾尖微微颤抖」表达; 改用肢体位移、发声、整体姿态或尾巴根部动作。",
    autoRewrite: true,
  },
  {
    key: "risk-deep-breath-transition",
    name: "深吸气驱动转折",
    type: "risk",
    severity: "medium",
    description: "情绪转折不要靠「深吸一口气」驱动, 用动作停顿或视线转移替代。",
    detectPatterns: ["深吸一口气", "深吸了一口气", "吐出一口气"],
    rewriteSuggestion: "情绪转折改为动作停顿、视线转移、手部动作或语言停顿。",
    promptInstruction: "情绪转折不要用「深吸一口气」「吐出一口气」驱动, 改用动作停顿、视线转移、手部动作或语言卡顿。",
    autoRewrite: true,
  },
  {
    key: "risk-weak-adverb-mushroom",
    name: "弱化副词泛滥",
    type: "risk",
    severity: "medium",
    description: "限制「微微」「缓缓」等弱化副词, 直接写动作强度。",
    detectPatterns: ["微微", "缓缓"],
    rewriteSuggestion: "弱化副词替换为明确的动作强度描写或具体动作。",
    promptInstruction: "限制「微微」「缓缓」等弱化副词, 每章同类不超过 2 次; 直接写动作强度或具体动作, 不要靠副词模糊化。",
    autoRewrite: true,
  },
  {
    key: "risk-even-simile",
    name: "比喻工整化",
    type: "risk",
    severity: "medium",
    description: "比喻要粗糙、私人、有偏差, 避免每个比喻都工整。",
    detectPatterns: ["像一盏.{0,4}灯", "像一锅.{0,4}油", "像一道闪电", "像一把.{0,4}刀"],
    rewriteSuggestion: "比喻改为粗糙、私人化、带偏差或非标准联想, 减少密度。",
    promptInstruction: "比喻要粗糙、私人、带偏差, 避免工整的「像一盏 X 灯」「像一锅 X 油」句式; 每章比喻不超过 3 个, 句式不重复。",
    autoRewrite: true,
  },
  {
    key: "risk-freeze-frame-ending",
    name: "定格收章模式",
    type: "risk",
    severity: "high",
    description: "收章不要「环境特写+预兆短句」凝练定格, 收尾应有变化。",
    detectPatterns: ["它在沉默。", "画外音"],
    rewriteSuggestion: "收尾改用动作未完、对话被打断、信息插入或场景切换, 避免凝练短句定格。",
    promptInstruction: "收章不要用「环境特写 + 预兆凝练短句」定格(如「它在沉默」「画外音」等); 收尾应有变化: 动作未完、对话被打断、信息插入、或场景硬切。",
    autoRewrite: true,
  },
  {
    key: "risk-omniscient-aside",
    name: "全知旁白他知道",
    type: "risk",
    severity: "medium",
    description: "限制「他知道」「他清楚」全知旁白, 转为具体察觉过程。",
    detectPatterns: ["他知道,", "他知道,", "他清楚,"],
    rewriteSuggestion: "全知旁白转为人物具体察觉过程: 视觉证据、推理链、或感觉线索。",
    promptInstruction: "限制「他知道」「他清楚」等全知旁白; 转为人物具体察觉过程: 视觉证据、推理线索、或身体感觉。",
    autoRewrite: true,
  },
];

const PROFILE = {
  name: "灵兽图鉴-去AI味 v1",
  description: "本小说专属 anti-AI 规则集, 针对 171 章实测高频套词(琥珀色眼睛/尾尖/深吸气/微微缓缓/工整比喻/定格收章/他知道)的 risk 级约束。新建于 default profile 之外, 免疫 sync_existing seed。",
  category: "novel_specific",
  tags: ["anti_ai", "furgusu", "risk_first"],
};

const BINDING_PRIORITY = 100;
const BINDING_WEIGHT = 10;

async function main() {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. 新增 7 条规则 (若 key 已存在则跳过)
      const ruleIds = [];
      for (const rule of RULES) {
        const existing = await tx.antiAiRule.findUnique({
          where: { key: rule.key },
          select: { id: true },
        });
        if (existing) {
          ruleIds.push(existing.id);
          continue;
        }
        const created = await tx.antiAiRule.create({
          data: {
            key: rule.key,
            name: rule.name,
            type: rule.type,
            severity: rule.severity,
            description: rule.description,
            detectPatternsJson: JSON.stringify(rule.detectPatterns),
            rewriteSuggestion: rule.rewriteSuggestion,
            promptInstruction: rule.promptInstruction,
            autoRewrite: rule.autoRewrite,
            enabled: true,
            globalBaselineEnabled: false,
          },
        });
        ruleIds.push(created.id);
      }

      // 2. 新建本小说专属 profile (sourceRefId 占位避免被 default seed 误碰)
      const profile = await tx.styleProfile.create({
        data: {
          name: PROFILE.name,
          description: PROFILE.description,
          category: PROFILE.category,
          tagsJson: JSON.stringify(PROFILE.tags),
          status: "active",
          sourceType: "from_text",
          sourceRefId: `novel_specific:${NOVEL_ID}:anti_ai_v1`,
          narrativeRulesJson: JSON.stringify({}),
          characterRulesJson: JSON.stringify({}),
          languageRulesJson: JSON.stringify({}),
          rhythmRulesJson: JSON.stringify({}),
        },
      });

      // 3. 关联规则到 profile (enabled=true, 带 weight)
      for (const ruleId of ruleIds) {
        await tx.styleProfileAntiAiRule.create({
          data: {
            styleProfileId: profile.id,
            antiAiRuleId: ruleId,
            enabled: true,
            weight: 10,
          },
        });
      }

      // 4. 绑定 profile 到本小说
      const binding = await tx.styleBinding.create({
        data: {
          styleProfileId: profile.id,
          targetType: "novel",
          targetId: NOVEL_ID,
          priority: BINDING_PRIORITY,
          weight: BINDING_WEIGHT,
          enabled: true,
        },
      });

      return { ruleIds, profileId: profile.id, bindingId: binding.id };
    });

    console.log("注入完成:", JSON.stringify(result, null, 2));
    console.log(`rules: ${result.ruleIds.length}, profile: ${result.profileId}, binding: ${result.bindingId}`);
  } catch (err) {
    console.error("注入失败:", err);
    process.exitCode = 1;
  }
}

main();
