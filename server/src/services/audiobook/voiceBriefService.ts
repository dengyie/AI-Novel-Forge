/**
 * VoiceBrief：角色+书级上下文 → 结构化音色画像。
 * LLM 失败时回退规则 Brief（现 gender/age/cluster/slot 启发）。
 */
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { voiceBriefPrompt } from "../../prompting/prompts/audiobook/voiceBrief.prompts";
import {
  inferAgeBucket,
  inferGenderBucket,
  inferVoiceSlot,
  resolveVoiceCluster,
  type VoiceAgeBucket,
  type VoiceCluster,
  type VoiceEnergyBand,
  type VoiceGenderBucket,
  type VoicePitchBand,
  type VoicePlannerCharacterInput,
  type VoiceTextureBand,
} from "./audiobookVoicePlanner";

export interface VoiceBrief {
  gender: VoiceGenderBucket;
  age: VoiceAgeBucket;
  cluster: VoiceCluster;
  pitch: VoicePitchBand;
  texture: VoiceTextureBand;
  energy: VoiceEnergyBand;
  personaTags: string[];
  avoidTags: string[];
  oneLine: string;
  confidence: number;
  source: "rule" | "llm";
}

export interface BookVoiceContext {
  title?: string | null;
  description?: string | null;
  styleTone?: string | null;
  bookSellingPoint?: string | null;
  first30ChapterPromise?: string | null;
  competingFeel?: string | null;
  narrativePov?: string | null;
  genreName?: string | null;
  storyModeName?: string | null;
  worldSummary?: string | null;
}

export function buildRuleVoiceBrief(
  character: VoicePlannerCharacterInput,
  book?: BookVoiceContext | null,
): VoiceBrief {
  const gender = inferGenderBucket(character);
  const age = inferAgeBucket(character);
  const cluster = resolveVoiceCluster(character);
  const slot = inferVoiceSlot(character);
  const personaTags = extractPersonaTags(character, book);
  const oneLine = [
    character.characterName,
    character.castRole || character.role || "",
    character.personality?.slice(0, 40) || "",
    character.voiceTexture || "",
    book?.styleTone ? `文风:${book.styleTone.slice(0, 24)}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 180);

  return {
    gender,
    age,
    cluster,
    pitch: slot.pitchBand,
    texture: slot.textureBand,
    energy: slot.energyBand,
    personaTags,
    avoidTags: [],
    oneLine: oneLine || `${character.characterName} 默认听感`,
    confidence: 0.45,
    source: "rule",
  };
}

function extractPersonaTags(
  character: VoicePlannerCharacterInput,
  book?: BookVoiceContext | null,
): string[] {
  const blob = [
    character.personality,
    character.voiceTexture,
    character.appearance,
    character.background,
    character.firstImpression,
    character.storyFunction,
    character.role,
    character.castRole,
    book?.styleTone,
    book?.competingFeel,
    book?.worldSummary,
    book?.genreName,
  ]
    .filter(Boolean)
    .join(" ");
  const tags = new Set<string>();
  const rules: Array<[RegExp, string]> = [
    [/清冷|冷傲|高冷/, "清冷"],
    [/温柔|软|暖/, "温柔"],
    [/沙哑|哑|沧桑/, "沙哑"],
    [/清亮|脆|甜/, "清亮"],
    [/沉稳|稳重|威严/, "沉稳"],
    [/活泼|灵动|俏/, "活泼"],
    [/少年|少女|青春/, "少年感"],
    [/帝王|王|帝|君/, "帝王"],
    [/军|将|兵/, "军人"],
    [/仙|道|玄|修/, "仙侠"],
    [/都市|现代|职场/, "都市"],
    [/古风|古代|朝堂/, "古风"],
    [/反派|阴狠|狠厉/, "反派"],
    [/旁白|解说/, "旁白"],
  ];
  for (const [re, tag] of rules) {
    if (re.test(blob)) tags.add(tag);
  }
  return [...tags].slice(0, 10);
}

function clip(s: string | null | undefined, n: number): string {
  const t = (s || "").trim();
  if (!t) return "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function formatBookContext(book?: BookVoiceContext | null): string {
  if (!book) return "";
  return [
    book.title ? `书名：${clip(book.title, 80)}` : "",
    book.genreName ? `题材：${clip(book.genreName, 40)}` : "",
    book.storyModeName ? `故事模式：${clip(book.storyModeName, 40)}` : "",
    book.styleTone ? `文风：${clip(book.styleTone, 120)}` : "",
    book.narrativePov ? `视角：${clip(String(book.narrativePov), 40)}` : "",
    book.bookSellingPoint ? `卖点：${clip(book.bookSellingPoint, 160)}` : "",
    book.first30ChapterPromise ? `前30章承诺：${clip(book.first30ChapterPromise, 160)}` : "",
    book.competingFeel ? `竞品感：${clip(book.competingFeel, 120)}` : "",
    book.description ? `简介：${clip(book.description, 240)}` : "",
    book.worldSummary ? `世界观：${clip(book.worldSummary, 240)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatCharacterCard(character: VoicePlannerCharacterInput): string {
  return [
    `名：${character.characterName}`,
    character.gender ? `性别：${character.gender}` : "",
    character.castRole ? `castRole：${character.castRole}` : "",
    character.role ? `身份：${clip(character.role, 80)}` : "",
    character.personality ? `性格：${clip(character.personality, 160)}` : "",
    character.voiceTexture ? `声线：${clip(character.voiceTexture, 80)}` : "",
    character.appearance ? `外貌：${clip(character.appearance, 120)}` : "",
    character.background ? `背景：${clip(character.background, 160)}` : "",
    character.storyFunction ? `功能：${clip(character.storyFunction, 80)}` : "",
    character.firstImpression ? `第一印象：${clip(character.firstImpression, 80)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function buildVoiceBrief(input: {
  character: VoicePlannerCharacterInput;
  book?: BookVoiceContext | null;
  dialogueSample?: string | null;
  useLlm?: boolean;
  provider?: LLMProvider;
  model?: string;
}): Promise<VoiceBrief> {
  const rule = buildRuleVoiceBrief(input.character, input.book);
  if (input.useLlm === false) return rule;

  // env VOICE_PLAN_BRIEF_LLM=0 强制规则
  if (process.env.VOICE_PLAN_BRIEF_LLM?.trim() === "0") return rule;

  try {
    const result = await runStructuredPrompt({
      asset: voiceBriefPrompt,
      promptInput: {
        characterName: input.character.characterName,
        characterCard: formatCharacterCard(input.character),
        bookContext: formatBookContext(input.book),
        dialogueSample: clip(input.dialogueSample, 400) || "（无）",
      },
      options: {
        provider: input.provider,
        model: input.model,
        temperature: 0.2,
      },
    });
    const o = result.output;
    return {
      gender: o.gender,
      age: o.age,
      cluster: o.cluster,
      pitch: o.pitch,
      texture: o.texture,
      energy: o.energy,
      personaTags: (o.personaTags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 12),
      avoidTags: (o.avoidTags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8),
      oneLine: (o.oneLine || rule.oneLine).slice(0, 200),
      confidence: typeof o.confidence === "number" ? o.confidence : 0.7,
      source: "llm",
    };
  } catch {
    return rule;
  }
}
