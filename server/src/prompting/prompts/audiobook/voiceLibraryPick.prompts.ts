import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { PromptAsset } from "../../core/promptTypes";

export const voiceLibraryPickSchema = z.object({
  assetId: z.string().nullable(),
  reason: z.string().max(300).default(""),
});

export type VoiceLibraryPickPromptOutput = z.infer<typeof voiceLibraryPickSchema>;

export interface VoiceLibraryPickPromptInput {
  briefText: string;
  catalogText: string;
  allowedAssetIds: string[];
}

export const voiceLibraryPickPrompt: PromptAsset<
  VoiceLibraryPickPromptInput,
  VoiceLibraryPickPromptOutput
> = {
  id: "audiobook.voice.library_pick",
  version: "v1",
  taskType: "planner",
  mode: "structured",
  language: "zh",
  contextPolicy: { maxTokensBudget: 0 },
  semanticRetryPolicy: { maxAttempts: 1 },
  outputSchema: voiceLibraryPickSchema,
  render: (input) => [
    new SystemMessage(
      [
        "你是有声书音色库选配器。从给定候选目录中选一个最合适的 assetId，或返回 null。",
        "硬性：assetId 必须出现在候选列表中；禁止编造 id/path。",
        "只输出 JSON：{\"assetId\":\"...\"|null,\"reason\":\"...\"}。",
        "若无足够匹配请返回 assetId=null，由下游规则回退。",
      ].join("\n"),
    ),
    new HumanMessage(
      [
        "角色 VoiceBrief：",
        input.briefText,
        "",
        "候选目录（仅可从中选）：",
        input.catalogText,
      ].join("\n"),
    ),
  ],
  postValidate: (output, input) => {
    const allowed = new Set(input.allowedAssetIds);
    if (output.assetId != null && output.assetId.trim() && !allowed.has(output.assetId.trim())) {
      return {
        ...output,
        assetId: null,
        reason: `${output.reason || ""}（丢弃非法 assetId）`.trim(),
      };
    }
    return output;
  },
};
