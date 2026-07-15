import type { Character, CharacterCastRole, CharacterGender } from "@ai-novel/shared/types/novel";

const CAST_ROLE_LABELS: Record<CharacterCastRole, string> = {
  protagonist: "主角",
  antagonist: "主对手",
  ally: "同盟",
  foil: "镜像角色",
  mentor: "导师",
  love_interest: "情感牵引",
  pressure_source: "压力源",
  catalyst: "催化者",
};

const CHARACTER_GENDER_LABELS: Record<CharacterGender, string> = {
  male: "男",
  female: "女",
  other: "其他",
  unknown: "未知",
};

export function getCastRoleLabel(castRole?: CharacterCastRole | null): string {
  if (!castRole) {
    return "未定义";
  }
  return CAST_ROLE_LABELS[castRole] ?? castRole;
}

export function getCharacterGenderLabel(gender?: CharacterGender | null): string {
  if (!gender) {
    return "未知";
  }
  return CHARACTER_GENDER_LABELS[gender] ?? gender;
}

export function isProtagonistCharacter(character?: Character | null): boolean {
  if (!character) {
    return false;
  }
  if (character.castRole === "protagonist") {
    return true;
  }
  const roleText = `${character.role ?? ""} ${character.castRole ?? ""}`;
  return /主角|男主|女主|主人公/.test(roleText);
}

export type CharacterVoiceMode = "preset" | "design" | "clone";

export type CharacterVoiceBinding = {
  mode: CharacterVoiceMode;
  ready: boolean;
  /** 列表短标签：茉莉 / 设计音色 / 克隆 / 未配音色 */
  shortLabel: string;
  /** 详情：预置 · 茉莉 / 文案设计 · 前 24 字… */
  detailLabel: string;
  modeLabel: string;
};

const TTS_MODE_LABELS: Record<CharacterVoiceMode, string> = {
  preset: "预置音色",
  design: "文案设计",
  clone: "参考克隆",
};

export function resolveCharacterVoiceMode(value?: string | null): CharacterVoiceMode {
  const mode = value?.trim();
  if (mode === "design" || mode === "clone" || mode === "preset") {
    return mode;
  }
  return "preset";
}

/** 有声书音色绑定摘要：列表徽章 / 焦点摘要 / 配置区共用。 */
export function resolveCharacterVoiceBinding(character?: {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
} | null): CharacterVoiceBinding {
  const mode = resolveCharacterVoiceMode(character?.ttsMode);
  const modeLabel = TTS_MODE_LABELS[mode];

  if (mode === "design") {
    const prompt = character?.ttsDesignPrompt?.trim() ?? "";
    const ready = prompt.length > 0;
    return {
      mode,
      ready,
      modeLabel,
      shortLabel: ready ? "设计音色" : "未配音色",
      detailLabel: ready
        ? `${modeLabel} · ${prompt.length > 28 ? `${prompt.slice(0, 28)}…` : prompt}`
        : `${modeLabel} · 缺设计文案`,
    };
  }

  if (mode === "clone") {
    const path = character?.ttsRefAudioPath?.trim() ?? "";
    const ready = path.length > 0;
    const fileName = path ? path.split(/[\\/]/).pop() || path : "";
    return {
      mode,
      ready,
      modeLabel,
      shortLabel: ready ? "克隆音色" : "未配音色",
      detailLabel: ready
        ? `${modeLabel} · ${fileName}`
        : `${modeLabel} · 缺参考音频`,
    };
  }

  const voice = character?.ttsVoice?.trim() ?? "";
  const ready = voice.length > 0;
  return {
    mode,
    ready,
    modeLabel,
    shortLabel: ready ? voice : "未配音色",
    detailLabel: ready ? `${modeLabel} · ${voice}` : `${modeLabel} · 未选择`,
  };
}
