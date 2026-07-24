import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { PromptAsset } from "../../core/promptTypes";

/**
 * 专用分轨 LLM：只做通道 + 说话人，禁止 delivery。
 * 与 audiobook.chapter.annotate 拆域，避免表演字段拖垮 diarize。
 */
export const audiobookChapterDiarizeOutputSchema = z.object({
  segments: z
    .array(
      z.object({
        segmentKind: z
          .enum([
            "speech",
            "narration",
            "typed",
            "chat",
            "on_screen",
            "phone",
            "broadcast",
            "inner",
            "quote_read",
            "sfx_cue",
          ])
          .optional()
          .nullable(),
        speakerKind: z.enum(["narrator", "character"]),
        speakerName: z.string().trim().min(1).max(64).optional().nullable(),
        text: z.string().trim().min(1).max(8000),
        channelHint: z.string().trim().max(40).optional().nullable(),
        confidence: z.number().min(0).max(1).optional().nullable(),
      }),
    )
    .min(1)
    .max(400),
});

export type AudiobookChapterDiarizeOutput = z.infer<typeof audiobookChapterDiarizeOutputSchema>;

export interface AudiobookChapterDiarizePromptInput {
  chapterOrder: number;
  chapterTitle: string;
  chapterContent: string;
  characterRosterText: string;
  narratorLabel: string;
  /** 规则预切摘要（可选，帮助模型对齐 quote） */
  ruleSpanSummary?: string;
}

const EXAMPLE = {
  segments: [
    { segmentKind: "narration", speakerKind: "narrator", speakerName: "旁白", text: "夜色渐深。" },
    {
      segmentKind: "speech",
      speakerKind: "character",
      speakerName: "何屿",
      text: "别回头。",
      confidence: 0.9,
    },
    {
      segmentKind: "typed",
      speakerKind: "narrator",
      speakerName: "打字",
      text: "收到",
      channelHint: "手机输入",
      confidence: 0.95,
    },
  ],
};

export const audiobookChapterDiarizePrompt: PromptAsset<
  AudiobookChapterDiarizePromptInput,
  AudiobookChapterDiarizeOutput
> = {
  id: "audiobook.chapter.diarize",
  version: "v1",
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
    example: EXAMPLE,
    note: "segments 数组；先判 segmentKind 通道，再判 speaker；禁止 delivery 字段。",
  },
  outputSchema: audiobookChapterDiarizeOutputSchema,
  render: (input) => {
    const systemRules = [
      "你是中文有声书「分轨 / 通道」标注器（diarize）。",
      "任务：把章节正文切成按顺序的 segments，标注 segmentKind（通道）与说话人。",
      "禁止输出 delivery / 情绪表演字段；禁止改写剧情；禁止把非口语通道标成 speech 只为听起来完整。",
      "只输出一个合法 JSON：{\"segments\":[...]}。",
      "",
      "segmentKind：",
      "- speech：口头发声的对白",
      "- narration：叙述、动作、环境、未出声心理（默认可朗读旁白）",
      "- typed：手机打字/输入中/未发出的字 → 必须 typed（系统会 skip 不念）",
      "- chat：IM/短信/气泡已发送文案 → chat（默认 skip）",
      "- on_screen：屏幕/告示/UI 字 → on_screen（默认 skip）",
      "- phone：电话另一端",
      "- broadcast：广播/电视/喇叭",
      "- inner：内心独白（心想/暗道）",
      "- quote_read：角色朗读纸面/屏幕上的字（说话人=朗读者）",
      "- sfx_cue：音效提示（少用）",
      "",
      "规则：",
      "1. speakerKind 只能是 narrator 或 character。",
      "2. 引号内直接引语且语境为说话 → speech + character；有「X说/道/问」优先用角色表正式名。",
      "3. 「打字/输入/键入/敲下」+ 引号内容 → typed，不要 speech。",
      "4. 「微信/短信/消息/气泡」+ 引号 → chat。",
      "5. character 的 speakerName 尽量匹配角色表；外号映射正式名；无法匹配仍写原文称呼。",
      "6. 不要扩写/删剧情；可最小切分与标点整理；单段不宜超过约 500 字。",
      "7. 合并连续同 speaker + 同 segmentKind 的短句。",
      "8. 覆盖**本段输入正文**主线（可能是整章，也可能是超长章的一块）；不要空 segments；不要假设你见过前后章或其它块。",
      "9. narrator 的 speakerName 可写「旁白」；typed/chat 可用「打字」「消息」。",
      "10. 若提供了「规则预切摘要」，应对齐其中的 quote，不要把应出声对白整段吞进 narration。",
      "11. 角色归属只根据本段正文 + 角色表判断，禁止跨章/全文推断。",
      "12. **phone vs on_screen**：电话/通话/听筒/那头传来/手机里说 → phone（要出声 tts）；只有屏幕上的文字/告示/UI 标签/弹窗提示 → on_screen（skip）。禁止把口头短句「吃饭了吗」「吃了」「在吗」标成 on_screen。",
      "13. **口头发声优先**：带「说/道/问/喊/答/回」「电话里」「那边说」的引号 → speech 或 phone，绝不要 typed/chat/on_screen。",
      "14. 无说话人线索但明显是当面/电话对话的引号 → 仍标 speech（或 phone），speakerName 写能推断的称呼；不要为了「安全」标 on_screen skip。",
    ];

    return [
      new SystemMessage(systemRules.join("\n")),
      new HumanMessage(
        [
          `章节：第 ${input.chapterOrder} 章 ${input.chapterTitle}`,
          "范围：仅下方「正文」片段（按章/按块调用；非全书）。",
          `默认旁白标签：${input.narratorLabel}`,
          "",
          "角色表：",
          input.characterRosterText || "（无角色卡）",
          "",
          input.ruleSpanSummary?.trim()
            ? `规则预切摘要（对齐用）：\n${input.ruleSpanSummary.trim()}\n`
            : "",
          `输出示例：${JSON.stringify(EXAMPLE)}`,
          "",
          "正文：",
          input.chapterContent,
        ].filter(Boolean).join("\n"),
      ),
    ];
  },
};
