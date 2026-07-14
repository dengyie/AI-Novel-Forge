import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { PromptAsset } from "../../core/promptTypes";

export const audiobookChapterAnnotateOutputSchema = z.object({
  segments: z.array(z.object({
    speakerKind: z.enum(["narrator", "character"]),
    /** 角色展示名；旁白可省略或写「旁白」 */
    speakerName: z.string().trim().min(1).max(64).optional().nullable(),
    text: z.string().trim().min(1).max(8000),
  })).min(1).max(400),
});

export type AudiobookChapterAnnotateOutput = z.infer<typeof audiobookChapterAnnotateOutputSchema>;

export interface AudiobookChapterAnnotatePromptInput {
  chapterOrder: number;
  chapterTitle: string;
  chapterContent: string;
  characterRosterText: string;
  narratorLabel: string;
}

const EXAMPLE = {
  segments: [
    { speakerKind: "narrator", speakerName: "旁白", text: "夜色渐深，长街只剩脚步声。" },
    { speakerKind: "character", speakerName: "林远", text: "别回头。" },
    { speakerKind: "narrator", speakerName: "旁白", text: "他压低声音，目光扫过巷口。" },
  ],
};

export const audiobookChapterAnnotatePrompt: PromptAsset<
  AudiobookChapterAnnotatePromptInput,
  AudiobookChapterAnnotateOutput
> = {
  id: "audiobook.chapter.annotate",
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
    note: "segments 必须是数组；speakerKind 只能是 narrator 或 character；角色名尽量匹配角色表。",
  },
  outputSchema: audiobookChapterAnnotateOutputSchema,
  render: (input) => [
    new SystemMessage([
      "你是中文有声书说话人标注器。",
      "任务：把小说章节正文切成按顺序朗读的 segments，区分旁白与角色对白。",
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
    ].join("\n")),
    new HumanMessage([
      `章节：第 ${input.chapterOrder} 章 ${input.chapterTitle}`,
      `默认旁白标签：${input.narratorLabel}`,
      "",
      "角色表：",
      input.characterRosterText || "（无角色卡，对白无法匹配时请标 narrator）",
      "",
      "正文：",
      input.chapterContent,
    ].join("\n")),
  ],
};
