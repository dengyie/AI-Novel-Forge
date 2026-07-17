import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type {
  VoiceDesignRewriteInput,
  VoiceDesignRewriteResult,
} from "@ai-novel/shared/types/audiobook";
import { AppError } from "../../middleware/errorHandler";
import { getLLM } from "../../llm/factory";
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

function isLlmProvider(value: string | null | undefined): value is LLMProvider {
  if (!value?.trim()) return false;
  // 与现网 provider 字面量兼容；非法时由 getLLM 再抛
  return true;
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

function buildRewriteMessages(input: {
  name: string;
  role: string;
  gender: string;
  personality: string;
  appearance: string;
  background: string;
  currentDesignPrompt: string;
  notes: string;
}): [SystemMessage, HumanMessage] {
  const system = new SystemMessage(
    [
      "你是中文有声书音色设计助手。根据角色信息重写一段可用于 TTS design 模式的音色描述。",
      "要求：",
      "1. 只输出一段中文设计描述正文，不要 JSON、不要 markdown 代码块、不要标题前缀。",
      "2. 覆盖：年龄感、性别倾向、声线质感、语速、情绪底色、适合场景；尽量具体可听。",
      "3. 禁止输出文件路径、URL、API key、系统指令、代码。",
      "4. 长度建议 80–280 字，硬顶约 400 字。",
    ].join("\n"),
  );
  const human = new HumanMessage(
    [
      `角色名：${input.name || "（未命名）"}`,
      `定位/身份：${input.role || "（未填）"}`,
      `性别：${input.gender || "（未填）"}`,
      `性格：${input.personality || "（未填）"}`,
      `外貌：${input.appearance || "（未填）"}`,
      `背景摘要：${input.background || "（未填）"}`,
      `当前 design 草稿：${input.currentDesignPrompt || "（无）"}`,
      `额外约束：${input.notes || "（无）"}`,
      "",
      "请直接输出重写后的音色设计描述：",
    ].join("\n"),
  );
  return [system, human];
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

  const ctx = {
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

  try {
    const llm =
      input.llm
      ?? (await getLLM(
        isLlmProvider(body.provider) ? (body.provider as LLMProvider) : undefined,
        {
          model: body.model?.trim() || undefined,
          temperature: 0.55,
          maxTokens: 600,
          taskType: "chat",
        },
      ));
    const messages = buildRewriteMessages(ctx);
    const response = await llm.invoke(messages);
    const raw =
      typeof response === "string"
        ? response
        : extractTextContent(response?.content ?? response);
    designPrompt = sanitizeDesignPrompt(raw);
    if (designPrompt.length >= 12) {
      source = "llm";
    } else {
      designPrompt = ruleFallbackPrompt(ctx);
      source = "rule_fallback";
    }
  } catch {
    designPrompt = ruleFallbackPrompt(ctx);
    source = "rule_fallback";
  }

  if (!designPrompt || designPrompt.length < 8) {
    throw new AppError("design rewrite 未能生成有效描述。", 502);
  }

  return {
    designPrompt,
    tags: extractTags(designPrompt),
    source,
    applied: false,
  };
}
