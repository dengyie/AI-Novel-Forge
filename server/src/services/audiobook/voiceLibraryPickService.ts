/**
 * LibraryPick：Brief + 预筛 catalog → structured LLM 选 assetId。
 * 非法 id 丢弃；失败返回 null 由规则 match 回退。
 */
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { voiceLibraryPickPrompt } from "../../prompting/prompts/audiobook/voiceLibraryPick.prompts";
import type { VoicePlannerLibraryAsset } from "./audiobookVoicePlanner";
import type { VoiceBrief } from "./voiceBriefService";

export interface LibraryPickResult {
  assetId: string | null;
  reason: string;
  source: "llm" | "none";
}

export async function pickLibraryAssetWithLlm(input: {
  brief: VoiceBrief;
  candidates: VoicePlannerLibraryAsset[];
  provider?: LLMProvider;
  model?: string;
}): Promise<LibraryPickResult> {
  const candidates = (input.candidates || []).filter((a) => a?.id?.trim()).slice(0, 80);
  if (!candidates.length) {
    return { assetId: null, reason: "无候选", source: "none" };
  }
  if (process.env.VOICE_PLAN_AI_PICK?.trim() === "0") {
    return { assetId: null, reason: "VOICE_PLAN_AI_PICK=0", source: "none" };
  }

  const allowedAssetIds = candidates.map((c) => c.id);
  const catalogText = candidates
    .map((c, i) => {
      const tags = (c.tags || []).slice(0, 12).join(",");
      return `${i + 1}. id=${c.id} slug=${c.slug} name=${c.displayName} tags=${tags}`;
    })
    .join("\n");
  const briefText = [
    `gender=${input.brief.gender}`,
    `age=${input.brief.age}`,
    `cluster=${input.brief.cluster}`,
    `pitch=${input.brief.pitch}`,
    `texture=${input.brief.texture}`,
    `energy=${input.brief.energy}`,
    `personaTags=${input.brief.personaTags.join(",")}`,
    `avoidTags=${input.brief.avoidTags.join(",")}`,
    `oneLine=${input.brief.oneLine}`,
  ].join("\n");

  try {
    const result = await runStructuredPrompt({
      asset: voiceLibraryPickPrompt,
      promptInput: {
        briefText,
        catalogText,
        allowedAssetIds,
      },
      options: {
        provider: input.provider,
        model: input.model,
        temperature: 0.1,
      },
    });
    const id = result.output.assetId?.trim() || null;
    if (id && !allowedAssetIds.includes(id)) {
      return { assetId: null, reason: "非法 assetId 已丢弃", source: "llm" };
    }
    return {
      assetId: id,
      reason: (result.output.reason || "").slice(0, 300) || (id ? "llm pick" : "llm null"),
      source: "llm",
    };
  } catch (err) {
    return {
      assetId: null,
      reason: `llm pick 失败：${err instanceof Error ? err.message : String(err)}`,
      source: "none",
    };
  }
}
