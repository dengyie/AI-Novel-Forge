import crypto from "node:crypto";
import type { AudiobookTtsMode, CharacterVoicePreviewStatus } from "@ai-novel/shared/types/audiobook";
import { isAudiobookTtsMode, isMimoTtsPresetVoice } from "@ai-novel/shared/types/audiobook";
import { isValidPcmWavFile } from "./audiobookWav";

/** 试听样例硬顶（与 fingerprint 切片一致；Skills 2–5 句空间）。 */
export const CHARACTER_VOICE_PREVIEW_SAMPLE_TEXT_MAX = 200;

/**
 * 旧产品腔一句（禁止作默认鉴声句；仅兼容测旧指纹/回归）。
 * @deprecated 产品默认请用 resolveDefaultCharacterVoicePreviewText
 */
export const LEGACY_CHARACTER_VOICE_PREVIEW_TEXT =
  "我是这段故事里的角色，请听听我的声音是否合适。";

/**
 * 默认鉴声句：中性叙事/对白，3 句、有停顿，非产品 meta。
 * 无角色上下文时用此常量。
 */
export const DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT =
  "路是自己选的，就不必再回头望。风从巷口灌进来，我把领口拢了拢，继续往灯火少的那边走。谁先认输，谁就先把今晚的话咽回去。";

const PREVIEW_TEXT_HEAVY =
  "夜里的路灯只亮了半边。我站在门廊下，把要说的话压回胸口，声音放低，却一句不让。风从巷口灌进来，鞋底在青石上停了停，再往前一步。";

const PREVIEW_TEXT_LIVELY =
  "哎，你先别急着走！巷子那头还有个转弯，灯火一跳，我追了两步把话说明白。行了行了，今晚这事算我记下了，回头再找你。";

const PREVIEW_TEXT_FEMALE =
  "我把窗关严，又把袖口理平。你说的那些，我听见了，不会装没听懂。灯影一晃，我把语气放稳，把该回的话一句句说完。";

export type CharacterVoicePreviewCorpusHint = {
  gender?: string | null;
  energyBand?: "lively" | "even" | "heavy" | null;
  cluster?: "lead" | "cast" | "extra" | "narrator" | null;
};

/** 按角色底色选默认试听句；无 hint 时用通用中性句。 */
export function resolveDefaultCharacterVoicePreviewText(
  hint: CharacterVoicePreviewCorpusHint = {},
): string {
  const gender = (hint.gender ?? "").trim().toLowerCase();
  if (hint.energyBand === "lively") return PREVIEW_TEXT_LIVELY;
  if (hint.energyBand === "heavy") return PREVIEW_TEXT_HEAVY;
  if (gender === "female" || gender === "f") return PREVIEW_TEXT_FEMALE;
  return DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT;
}

export function clampCharacterVoicePreviewSampleText(text: string): string {
  return text.trim().slice(0, CHARACTER_VOICE_PREVIEW_SAMPLE_TEXT_MAX);
}

/** 句末标点计数（。！？…）；鉴声句质量门代理。 */
export function countPreviewSentenceEnders(text: string): number {
  const matches = text.match(/[。！？…]/g);
  return matches?.length ?? 0;
}

export type CharacterVoicePreviewConfig = {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  ttsVoiceAssetId?: string | null;
};

function normalizePart(value?: string | null): string {
  return (value ?? "").trim();
}

/** 配置指纹：mode|voice|style|design|ref|sampleText → sha256 hex。 */
export function buildCharacterVoicePreviewFingerprint(
  config: CharacterVoicePreviewConfig,
  sampleText: string,
): string {
  const mode = resolvePreviewTtsMode(config.ttsMode);
  const payload = [
    mode,
    normalizePart(config.ttsVoice),
    normalizePart(config.ttsStyle),
    normalizePart(config.ttsDesignPrompt),
    normalizePart(config.ttsRefAudioPath),
    normalizePart(config.ttsVoiceAssetId),
    clampCharacterVoicePreviewSampleText(normalizePart(sampleText)),
  ].join("|");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function resolvePreviewTtsMode(value?: string | null): AudiobookTtsMode {
  const mode = value?.trim() || "preset";
  if (isAudiobookTtsMode(mode)) {
    return mode;
  }
  return "preset";
}

export function assertCharacterVoiceReadyForPreview(config: CharacterVoicePreviewConfig): {
  mode: AudiobookTtsMode;
  voice: string;
  style: string | null;
  designPrompt: string | null;
  refAudioPath: string | null;
} {
  const mode = resolvePreviewTtsMode(config.ttsMode);
  const voice = normalizePart(config.ttsVoice);
  const style = normalizePart(config.ttsStyle) || null;
  const designPrompt = normalizePart(config.ttsDesignPrompt) || null;
  const refAudioPath = normalizePart(config.ttsRefAudioPath) || null;

  if (mode === "preset") {
    if (!voice || !isMimoTtsPresetVoice(voice)) {
      throw new Error("生成试听需要合法 MiMo 预置音色（请先保存角色音色）。");
    }
  } else if (mode === "design") {
    if (!designPrompt) {
      throw new Error("生成试听需要已保存的音色设计描述。");
    }
  } else if (!refAudioPath) {
    throw new Error("生成试听需要已保存的克隆参考音频。");
  }

  return { mode, voice, style, designPrompt, refAudioPath };
}

export function resolveCharacterVoicePreviewStatus(input: {
  audioPath?: string | null;
  fingerprint?: string | null;
  currentFingerprint: string;
}): CharacterVoicePreviewStatus {
  const audioPath = normalizePart(input.audioPath);
  if (!audioPath) {
    return "missing";
  }
  // 与合成 resume 同一套 PCM WAV 校验，拒绝伪 RIFF / 截断文件
  if (!isValidPcmWavFile(audioPath)) {
    return "missing";
  }
  const stored = normalizePart(input.fingerprint);
  if (!stored || stored !== input.currentFingerprint) {
    return "stale";
  }
  return "ready";
}

export function buildCharacterVoicePreviewAudioUrl(novelId: string, characterId: string): string {
  return `/novels/${encodeURIComponent(novelId)}/characters/${encodeURIComponent(characterId)}/voice-preview/audio`;
}
