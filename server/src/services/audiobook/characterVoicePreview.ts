import crypto from "node:crypto";
import fs from "node:fs";
import type { AudiobookTtsMode, CharacterVoicePreviewStatus } from "@ai-novel/shared/types/audiobook";
import { isAudiobookTtsMode, isMimoTtsPresetVoice } from "@ai-novel/shared/types/audiobook";

export const DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT = "我是这段故事里的角色，请听听我的声音是否合适。";

export type CharacterVoicePreviewConfig = {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
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
    normalizePart(sampleText).slice(0, 120),
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
  try {
    if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size <= 44) {
      return "missing";
    }
  } catch {
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
