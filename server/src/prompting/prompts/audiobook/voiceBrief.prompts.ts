import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { PromptAsset } from "../../core/promptTypes";

export const voiceBriefSchema = z.object({
  gender: z.enum(["male", "female", "unknown"]),
  age: z.enum(["youth", "adult", "elder", "unknown"]),
  cluster: z.enum(["lead", "cast", "extra", "narrator"]),
  pitch: z.enum(["high", "mid", "low"]),
  texture: z.enum(["bright", "neutral", "dark_raspy", "airy"]),
  energy: z.enum(["lively", "even", "heavy"]),
  personaTags: z.array(z.string()).max(12).default([]),
  avoidTags: z.array(z.string()).max(8).default([]),
  oneLine: z.string().max(200),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type VoiceBriefPromptOutput = z.infer<typeof voiceBriefSchema>;

export interface VoiceBriefPromptInput {
  characterName: string;
  characterCard: string;
  bookContext: string;
  dialogueSample: string;
}

export const voiceBriefPrompt: PromptAsset<VoiceBriefPromptInput, VoiceBriefPromptOutput> = {
  id: "audiobook.voice.brief",
  version: "v1",
  taskType: "planner",
  mode: "structured",
  language: "zh",
  contextPolicy: { maxTokensBudget: 0 },
  semanticRetryPolicy: { maxAttempts: 1 },
  outputSchema: voiceBriefSchema,
  render: (input) => [
    new SystemMessage(
      [
        "你是中文有声书音色规划助手。根据角色卡、书级世界观/文风、可选对白，输出结构化 VoiceBrief。",
        "只输出 JSON，不要 markdown。字段：gender/age/cluster/pitch/texture/energy/personaTags/avoidTags/oneLine/confidence。",
        "cluster：lead=主角，cast=主角团/重要配角，extra=路人，narrator=旁白。",
        "personaTags 用短词（如 清冷/沙哑/少年感/帝王/柔弱），避免路径与 id。",
        "中文小说默认按中文听感描述；禁止编造文件路径或 assetId。",
      ].join("\n"),
    ),
    new HumanMessage(
      [
        `角色名：${input.characterName}`,
        "角色卡：",
        input.characterCard || "（空）",
        "",
        "书级上下文：",
        input.bookContext || "（空）",
        "",
        "对白样本：",
        input.dialogueSample || "（无）",
      ].join("\n"),
    ),
  ],
};
