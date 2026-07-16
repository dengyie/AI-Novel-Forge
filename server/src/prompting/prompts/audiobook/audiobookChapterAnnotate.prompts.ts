import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { PromptAsset } from "../../core/promptTypes";

/**
 * delivery 全 optional / partial，禁止 required 拖垮 structured → 整章旁白。
 * Core 默认在服务端 normalizeDelivery 补齐。
 */
const deliverySchema = z
  .object({
    primaryEmotion: z.string().trim().min(1).max(24).optional().nullable(),
    intensity: z.enum(["low", "mid", "high"]).optional().nullable(),
    surfaceTone: z.string().trim().min(1).max(32).optional().nullable(),
    intent: z.string().trim().min(1).max(40).optional().nullable(),
    vocalEffort: z
      .enum(["whisper", "soft", "normal", "raised", "strained"])
      .optional()
      .nullable(),
    rate: z
      .enum(["slow", "measured", "normal", "fast", "rushed"])
      .optional()
      .nullable(),
    maskOrLeak: z.string().trim().max(32).optional().nullable(),
    secondaryTraits: z.array(z.string().trim().max(24)).max(3).optional().nullable(),
    addresseeRelation: z.string().trim().max(24).optional().nullable(),
    subtext: z.string().trim().max(40).optional().nullable(),
    sceneSpace: z.string().trim().max(32).optional().nullable(),
    scenePressure: z.string().trim().max(32).optional().nullable(),
    pitchMove: z
      .enum(["lowered", "stable", "lifted", "cracked"])
      .optional()
      .nullable(),
    pauseBreath: z.string().trim().max(32).optional().nullable(),
    articulation: z.string().trim().max(32).optional().nullable(),
    nonverbalCue: z.string().trim().max(24).optional().nullable(),
    continuityFrom: z.string().trim().max(40).optional().nullable(),
    rawFactors: z.array(z.string().trim().max(24)).max(6).optional().nullable(),
    deliveryLine: z.string().trim().max(120).optional().nullable(),
  })
  .partial()
  .optional()
  .nullable();

export const audiobookChapterAnnotateOutputSchema = z.object({
  segments: z
    .array(
      z.object({
        speakerKind: z.enum(["narrator", "character"]),
        /** 角色展示名；旁白可省略或写「旁白」 */
        speakerName: z.string().trim().min(1).max(64).optional().nullable(),
        text: z.string().trim().min(1).max(8000),
        /** 段级表演；可省略。解析失败由调用方 normalize 为 null。 */
        delivery: deliverySchema,
      }),
    )
    .min(1)
    .max(400),
});

export type AudiobookChapterAnnotateOutput = z.infer<typeof audiobookChapterAnnotateOutputSchema>;

export interface AudiobookChapterAnnotatePromptInput {
  chapterOrder: number;
  chapterTitle: string;
  chapterContent: string;
  characterRosterText: string;
  narratorLabel: string;
  /** 是否请求模型输出 delivery（服务端 mode≠off 时 true） */
  requestDelivery?: boolean;
}

const EXAMPLE_SPEAKER_ONLY = {
  segments: [
    { speakerKind: "narrator", speakerName: "旁白", text: "夜色渐深，长街只剩脚步声。" },
    { speakerKind: "character", speakerName: "林远", text: "别回头。" },
    { speakerKind: "narrator", speakerName: "旁白", text: "他压低声音，目光扫过巷口。" },
  ],
};

const EXAMPLE_WITH_DELIVERY = {
  segments: [
    { speakerKind: "narrator", speakerName: "旁白", text: "夜色渐深，长街只剩脚步声。" },
    {
      speakerKind: "character",
      speakerName: "何屿",
      text: "你把责任说清楚。",
      delivery: {
        primaryEmotion: "压抑愤怒",
        intensity: "mid",
        surfaceTone: "平静公事",
        intent: "逼对方把责任说清楚",
        vocalEffort: "soft",
        rate: "measured",
        maskOrLeak: "强装镇定，牙关发紧",
        subtext: "表面问流程，其实拒再背锅",
        sceneSpace: "狭小出租屋夜谈",
        scenePressure: "一对一逼问",
        addresseeRelation: "对甩锅上级",
        continuityFrom: "承接对方冷笑，怒意未消",
        rawFactors: ["被甩锅", "领导冷笑", "夜"],
        deliveryLine:
          "平静公事地压着怒，强装镇定却牙关发紧；对上级逼问责任；压低音量、语速沉稳、句中短暂停再接。",
      },
    },
  ],
};

export const audiobookChapterAnnotatePrompt: PromptAsset<
  AudiobookChapterAnnotatePromptInput,
  AudiobookChapterAnnotateOutput
> = {
  id: "audiobook.chapter.annotate",
  version: "v2",
  taskType: "planner",
  mode: "structured",
  language: "zh",
  contextPolicy: {
    maxTokensBudget: 0,
  },
  semanticRetryPolicy: {
    maxAttempts: 1,
  },
  structuredOutputHint: {
    example: EXAMPLE_WITH_DELIVERY,
    note: "segments 必须是数组；speakerKind 只能是 narrator 或 character；角色名尽量匹配角色表；delivery 可选。",
  },
  outputSchema: audiobookChapterAnnotateOutputSchema,
  render: (input) => {
    const requestDelivery = input.requestDelivery === true;
    const systemRules = [
      "你是中文有声书说话人标注器。",
      requestDelivery
        ? "任务：把小说章节正文切成按顺序朗读的 segments，区分旁白与角色对白；角色对白尽量附带段级表演 delivery。"
        : "任务：把小说章节正文切成按顺序朗读的 segments，区分旁白与角色对白。",
      "只输出一个合法 JSON 对象，不要 Markdown、解释或额外文本。",
      "顶层固定：{\"segments\":[...]}。",
      "",
      "规则：",
      "1. speakerKind 只能是 narrator 或 character。",
      "2. 引号内的直接引语通常归 character；叙述、动作、心理描写归 narrator。",
      "3. character 的 speakerName 必须尽量匹配「角色表」中的正式名；若正文用外号/称呼，优先映射到角色表正式名（角色表可含别名）。无法匹配时仍写原文称呼，后续系统会回退旁白。",
      "4. 不要改写正文语义；可做最小切分与标点整理，但不要扩写、不要删剧情。",
      "5. 合并连续同一说话人的短句为一段，避免碎片化；单段不宜超过约 500 字。",
      "6. 覆盖整章正文主线内容；不要输出空 segments。",
      "7. narrator 的 speakerName 可写「旁白」或省略。",
      "8. 禁止因情绪分析改写 narrator/character 边界；先定 speaker，再填 delivery。",
      "9. 不把舞台指示 / stage direction 写进 text。",
    ];

    if (requestDelivery) {
      systemRules.push(
        "",
        "delivery（可选，角色段建议填；旁白可省略）：",
        "- Core：primaryEmotion、intensity(low|mid|high)、surfaceTone、intent、vocalEffort(whisper|soft|normal|raised|strained)、rate(slow|measured|normal|fast|rushed)。",
        "- Extended 有依据才填：maskOrLeak、subtext、sceneSpace、scenePressure、addresseeRelation、pitchMove、pauseBreath、articulation、nonverbalCue、continuityFrom、rawFactors、deliveryLine。",
        "- 字段分层不撞车：primaryEmotion=心里；surfaceTone=嘴上；maskOrLeak=面具/破绽；intent/subtext=意图；scene*=场景；vocal/rate=声道。",
        "- deliveryLine 必须具体可执行（情绪+语气+≥1 声道线索），禁止空话（有感情/生动/自然/请朗读），禁止复述台词，禁止改声线身份。",
        "- 可省略 deliveryLine（服务端会按字段编译）。",
        "- 相邻同角色建议填 continuityFrom。",
        "- 只根据正文邻域 + 角色表声线；禁止编造未写剧情。",
        "- 非高潮 intensity 默认 mid；禁止无依据全程 high。",
      );
    }

    const exampleNote = requestDelivery
      ? `输出示例（结构参考）：${JSON.stringify(EXAMPLE_WITH_DELIVERY)}`
      : `输出示例（结构参考）：${JSON.stringify(EXAMPLE_SPEAKER_ONLY)}`;

    return [
      new SystemMessage(systemRules.join("\n")),
      new HumanMessage(
        [
          `章节：第 ${input.chapterOrder} 章 ${input.chapterTitle}`,
          `默认旁白标签：${input.narratorLabel}`,
          "",
          "角色表：",
          input.characterRosterText || "（无角色卡，对白无法匹配时请标 narrator）",
          "",
          exampleNote,
          "",
          "正文：",
          input.chapterContent,
        ].join("\n"),
      ),
    ];
  },
};
