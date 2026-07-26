import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { isBuiltinLLMProvider } from "@ai-novel/shared/types/llm";
import type {
  VoiceDesignRewriteInput,
  VoiceDesignRewriteResult,
} from "@ai-novel/shared/types/audiobook";
import { AppError } from "../../middleware/errorHandler";
import { runTextPrompt } from "../../prompting/core/promptRunner";
import {
  renderVoiceDesignRewriteMessages,
  voiceDesignRewritePrompt,
  type VoiceDesignRewritePromptInput,
} from "../../prompting/prompts/audiobook/voiceDesignRewrite.prompts";
import {
  buildDesignPrompt,
  inferAgeBucket,
  inferGenderBucket,
  inferVoiceSlot,
  type VoicePlannerCharacterInput,
} from "./audiobookVoicePlanner";
import { prisma } from "../../db/prisma";

const DESIGN_PROMPT_MAX = 1200;
const NOTES_MAX = 400;

export type VoiceDesignRewriteLlm = {
  invoke: (messages: unknown[]) => Promise<{ content?: unknown } | string | null | undefined>;
};

function resolveOptionalProvider(value: string | null | undefined): LLMProvider | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (!isBuiltinLLMProvider(raw)) {
    throw new AppError(`不支持的 LLM provider：${raw}`, 400);
  }
  return raw;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function sanitizeDesignPrompt(raw: string): string {
  let text = raw
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*["']|["']\s*$/g, "")
    .replace(/[\\/](?:Users|home|personal|var|tmp|etc)[^\s]*/gi, "")
    .replace(/\b(?:ttsRefAudioPath|voiceAssetId|sourcePath)\s*[:=]\s*\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > DESIGN_PROMPT_MAX) {
    text = text.slice(0, DESIGN_PROMPT_MAX).trim();
  }
  return text;
}

function extractTags(prompt: string): string[] {
  const tags = new Set<string>();
  const lower = prompt.toLowerCase();
  const buckets: Array<[RegExp, string]> = [
    [/男|male|他/, "male"],
    [/女|female|她/, "female"],
    [/少年|青年|young/, "young"],
    [/中年|mature/, "mature"],
    [/老年|elder|苍老/, "elder"],
    [/沉稳|稳重|low|沉/, "steady"],
    [/沙哑|嘶|raspy/, "raspy"],
    [/明亮|清亮|bright/, "bright"],
    [/旁白|narrat/, "narrator"],
  ];
  for (const [re, tag] of buckets) {
    if (re.test(prompt) || re.test(lower)) tags.add(tag);
  }
  return [...tags].slice(0, 8);
}

function ruleFallbackPrompt(input: {
  name: string;
  role: string;
  gender: string;
  personality: string;
  appearance: string;
  currentDesignPrompt: string;
  notes: string;
}): string {
  const character: VoicePlannerCharacterInput = {
    characterId: "rewrite-fallback",
    characterName: input.name || "角色",
    gender: input.gender || null,
    role: input.role || null,
    personality: input.personality || null,
    appearance: input.appearance || null,
    ttsDesignPrompt: input.currentDesignPrompt || null,
  };
  const gender = inferGenderBucket(character);
  const age = inferAgeBucket(character);
  const slot = inferVoiceSlot(character);
  const base = buildDesignPrompt({
    character,
    gender,
    age,
    slot,
  });
  const pieces = [base];
  if (input.notes.trim()) {
    pieces.push(`约束：${input.notes.trim().slice(0, 120)}`);
  }
  return sanitizeDesignPrompt(pieces.join("。"));
}

export type VoiceDesignRewriteCharacter = {
  id: string;
  name: string | null;
  role: string | null;
  gender: string | null;
  personality: string | null;
  appearance: string | null;
  background: string | null;
  ttsDesignPrompt: string | null;
};

/**
 * 角色 design rewrite：返回候选，不写库/不写角色卡。
 * llm / loadCharacter 可注入（单测 mock）；默认 getLLM + chat 路由。
 */
export async function rewriteCharacterVoiceDesign(input: {
  novelId: string;
  characterId: string;
  body?: VoiceDesignRewriteInput | null;
  llm?: VoiceDesignRewriteLlm | null;
  loadCharacter?: (novelId: string, characterId: string) => Promise<VoiceDesignRewriteCharacter | null>;
}): Promise<VoiceDesignRewriteResult> {
  const novelId = input.novelId.trim();
  const characterId = input.characterId.trim();
  if (!novelId || !characterId) {
    throw new AppError("novelId/characterId 必填。", 400);
  }

  const character = input.loadCharacter
    ? await input.loadCharacter(novelId, characterId)
    : await prisma.character.findFirst({
        where: { id: characterId, novelId },
        select: {
          id: true,
          name: true,
          role: true,
          gender: true,
          personality: true,
          appearance: true,
          background: true,
          ttsDesignPrompt: true,
        },
      });
  if (!character) {
    throw new AppError("角色不存在。", 404);
  }

  const body = input.body ?? {};
  const currentDesignPrompt = (
    body.currentDesignPrompt?.trim()
    || character.ttsDesignPrompt?.trim()
    || ""
  ).slice(0, DESIGN_PROMPT_MAX);
  const notes = (body.notes?.trim() || "").slice(0, NOTES_MAX);

  const ctx: VoiceDesignRewritePromptInput = {
    name: character.name || "",
    role: character.role || "",
    gender: character.gender || "",
    personality: character.personality || "",
    appearance: character.appearance || "",
    background: (character.background || "").slice(0, 400),
    currentDesignPrompt,
    notes,
  };

  let designPrompt = "";
  let source: VoiceDesignRewriteResult["source"] = "rule_fallback";
  let fallbackReason: string | null = null;

  try {
    const provider = resolveOptionalProvider(body.provider);
    const raw = input.llm
      ? await (async () => {
        const response = await input.llm!.invoke(renderVoiceDesignRewriteMessages(ctx));
        return typeof response === "string"
          ? response
          : extractTextContent(response?.content ?? response);
      })()
      : (await runTextPrompt({
        asset: voiceDesignRewritePrompt,
        promptInput: ctx,
        options: {
          provider,
          model: body.model?.trim() || undefined,
          temperature: 0.55,
          maxTokens: 600,
        },
      })).output;
    designPrompt = sanitizeDesignPrompt(raw);
    if (designPrompt.length >= 12) {
      source = "llm";
    } else {
      designPrompt = ruleFallbackPrompt(ctx);
      source = "rule_fallback";
      fallbackReason = "llm_output_too_short";
      console.warn(
        "voice_design_rewrite_fallback",
        `characterId=${characterId}`,
        "reason=llm_output_too_short",
      );
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    designPrompt = ruleFallbackPrompt(ctx);
    source = "rule_fallback";
    fallbackReason = error instanceof Error ? error.message.slice(0, 160) : "llm_error";
    console.warn(
      "voice_design_rewrite_fallback",
      `characterId=${characterId}`,
      `reason=${fallbackReason.replace(/\s+/g, "_")}`,
    );
  }

  if (!designPrompt || designPrompt.length < 8) {
    throw new AppError("design rewrite 未能生成有效描述。", 502);
  }

  return {
    designPrompt,
    tags: extractTags(designPrompt),
    source,
    applied: false,
    fallbackReason: source === "rule_fallback" ? fallbackReason : null,
  };
}
