import type { Character, CharacterCastRole, CharacterGender } from "@ai-novel/shared/types/novel";
import {
  MIMO_TTS_VOICE_CATALOG,
  isMimoTtsPresetVoice,
  type AudiobookVoiceCatalogItem,
} from "@ai-novel/shared/types/audiobook";

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

export const CHARACTER_VOICE_MODE_OPTIONS: Array<{
  value: CharacterVoiceMode;
  label: string;
  helper: string;
}> = [
  { value: "preset", label: "预置", helper: "点名 MiMo 现成音色，最快可生成" },
  { value: "design", label: "文案设计", helper: "用描述造声线，适合定制人设" },
  { value: "clone", label: "克隆", helper: "从全站库绑定或上传参考音，保存后可试听/合成" },
];

export function resolveCharacterVoiceMode(value?: string | null): CharacterVoiceMode {
  const mode = value?.trim();
  if (mode === "design" || mode === "clone" || mode === "preset") {
    return mode;
  }
  return "preset";
}

export function findMimoVoiceCatalogItem(voiceId?: string | null): AudiobookVoiceCatalogItem | undefined {
  const id = voiceId?.trim();
  if (!id) {
    return undefined;
  }
  return MIMO_TTS_VOICE_CATALOG.find((item) => item.id === id);
}

/** 有声书音色绑定摘要：列表徽章 / 焦点摘要 / 配置区共用。 */
export function resolveCharacterVoiceBinding(character?: {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  ttsVoiceAssetId?: string | null;
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
    const assetId = character?.ttsVoiceAssetId?.trim() ?? "";
    const ready = path.length > 0 || assetId.length > 0;
    const shortAsset = assetId ? `库/${assetId.slice(0, 10)}` : "";
    const fileName = path ? path.split(/[\\/]/).pop() || path : "";
    return {
      mode,
      ready,
      modeLabel,
      shortLabel: ready ? (assetId ? "库克隆" : "克隆音色") : "未配音色",
      detailLabel: ready
        ? assetId
          ? `${modeLabel} · ${shortAsset}${fileName ? ` · ${fileName}` : ""}`
          : `${modeLabel} · ${fileName}`
        : `${modeLabel} · 缺参考音频/库绑定`,
    };
  }

  const voice = character?.ttsVoice?.trim() ?? "";
  const ready = voice.length > 0;
  const catalog = findMimoVoiceCatalogItem(voice);
  const displayVoice = catalog
    ? (catalog.description ? `${catalog.label}（${catalog.description}）` : catalog.label)
    : voice;
  return {
    mode,
    ready,
    modeLabel,
    shortLabel: ready ? (catalog?.label ?? voice) : "未配音色",
    detailLabel: ready ? `${modeLabel} · ${displayVoice}` : `${modeLabel} · 未选择`,
  };
}

export type CharacterVoiceFormSlice = {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  ttsRefAudioBase64?: string | null;
  /** 全站 VoiceAsset.id（clone 库绑定）。 */
  ttsVoiceAssetId?: string | null;
  /** 表单为逗号串；已保存角色可能是 string[]。 */
  ttsSpeakerAliases?: string | string[] | null;
};

function normalizeSpeakerAliases(value?: string | string[] | null): string {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean).join("、");
  }
  return (value ?? "").trim();
}

/** 表单相对已保存角色是否改了音色相关字段。 */
export function isCharacterVoiceFormDirty(
  form: CharacterVoiceFormSlice,
  saved?: CharacterVoiceFormSlice | null,
): boolean {
  const formMode = resolveCharacterVoiceMode(form.ttsMode);
  const savedMode = resolveCharacterVoiceMode(saved?.ttsMode);
  if (formMode !== savedMode) {
    return true;
  }
  if ((form.ttsVoice ?? "").trim() !== (saved?.ttsVoice ?? "").trim()) {
    return true;
  }
  if ((form.ttsStyle ?? "").trim() !== (saved?.ttsStyle ?? "").trim()) {
    return true;
  }
  if ((form.ttsDesignPrompt ?? "").trim() !== (saved?.ttsDesignPrompt ?? "").trim()) {
    return true;
  }
  if ((form.ttsRefAudioPath ?? "").trim() !== (saved?.ttsRefAudioPath ?? "").trim()) {
    return true;
  }
  if ((form.ttsVoiceAssetId ?? "").trim() !== (saved?.ttsVoiceAssetId ?? "").trim()) {
    return true;
  }
  if (normalizeSpeakerAliases(form.ttsSpeakerAliases) !== normalizeSpeakerAliases(saved?.ttsSpeakerAliases)) {
    return true;
  }
  if ((form.ttsRefAudioBase64 ?? "").trim().length > 0) {
    return true;
  }
  return false;
}

/**
 * 能否基于当前表单配置调用服务端生成试听（不含 dirty 门禁）。
 * clone：已落盘 path 或已绑库 assetId 可生成；草稿 base64 只能本地试听。
 */
export function canPreviewCharacterVoice(form: CharacterVoiceFormSlice): {
  ok: boolean;
  reason: string;
} {
  const mode = resolveCharacterVoiceMode(form.ttsMode);
  if (mode === "preset") {
    const voice = form.ttsVoice?.trim() ?? "";
    if (!voice) {
      return { ok: false, reason: "请先选择一个预置音色。" };
    }
    if (!isMimoTtsPresetVoice(voice)) {
      return { ok: false, reason: `「${voice}」不在 MiMo 预置表，请重新点选。` };
    }
    return { ok: true, reason: "" };
  }
  if (mode === "design") {
    const prompt = form.ttsDesignPrompt?.trim() ?? "";
    if (!prompt) {
      return { ok: false, reason: "请先填写音色设计描述。" };
    }
    return { ok: true, reason: "" };
  }
  const path = form.ttsRefAudioPath?.trim() ?? "";
  const assetId = form.ttsVoiceAssetId?.trim() ?? "";
  if (path || assetId) {
    return { ok: true, reason: "" };
  }
  if (form.ttsRefAudioBase64?.trim()) {
    return { ok: false, reason: "新参考音需先保存角色，再生成试听；可先本地听参考轨。" };
  }
  return { ok: false, reason: "请先从音色库绑定或上传并保存参考音频。" };
}

/**
 * 生成试听门禁：必须基于已保存配置；dirty 时禁止生成。
 */
export function canGenerateCharacterVoicePreview(input: {
  form: CharacterVoiceFormSlice;
  saved?: CharacterVoiceFormSlice | null;
}): {
  ok: boolean;
  reason: string;
} {
  if (isCharacterVoiceFormDirty(input.form, input.saved)) {
    return { ok: false, reason: "请先保存音色，再生成试听（基于已保存配置）。" };
  }
  return canPreviewCharacterVoice(input.saved ?? input.form);
}

/**
 * 角色保存时的 ttsRef / 库绑定请求片段。
 * - 有 base64 → 只传 base64（服务端清 asset 并写路径）
 * - clone + assetId → 传 ttsVoiceAssetId（服务端 assert approved 写路径）
 * - clone 且仅有服务端 path → 省略 path/asset，避免 400 且不误清
 * - 其它情况 → path:null + assetId:null 清空半绑定
 */
export function buildCharacterTtsRefSaveFields(input: {
  ttsMode?: string | null;
  ttsRefAudioPath?: string | null;
  ttsRefAudioBase64?: string | null;
  ttsVoiceAssetId?: string | null;
}): {
  ttsRefAudioBase64?: string | null;
  ttsRefAudioPath?: null;
  ttsVoiceAssetId?: string | null;
} {
  const mode = resolveCharacterVoiceMode(input.ttsMode);
  const trimmedPath = (input.ttsRefAudioPath ?? "").trim();
  const trimmedBase64 = (input.ttsRefAudioBase64 ?? "").trim();
  const trimmedAssetId = (input.ttsVoiceAssetId ?? "").trim();
  if (trimmedBase64) {
    // base64 上传优先；服务端会清 asset 绑定
    return { ttsRefAudioBase64: trimmedBase64, ttsVoiceAssetId: null };
  }
  if (mode === "clone" && trimmedAssetId) {
    return {
      ttsRefAudioBase64: null,
      ttsVoiceAssetId: trimmedAssetId,
    };
  }
  const keepServerRef = mode === "clone" && Boolean(trimmedPath);
  if (keepServerRef) {
    return { ttsRefAudioBase64: null };
  }
  return {
    ttsRefAudioBase64: null,
    ttsRefAudioPath: null,
    ttsVoiceAssetId: null,
  };
}

export type CharacterVoicePreviewStatusLabel = "missing" | "ready" | "stale";

export function resolveCharacterVoicePreviewBadge(status?: CharacterVoicePreviewStatusLabel | null): {
  label: string;
  tone: "ready" | "stale" | "missing";
} {
  if (status === "ready") {
    return { label: "试听✓", tone: "ready" };
  }
  if (status === "stale") {
    return { label: "试听过期", tone: "stale" };
  }
  return { label: "无试听", tone: "missing" };
}
