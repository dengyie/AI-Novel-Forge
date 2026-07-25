/**
 * 未匹配角色卡时的「路人」预置音色：与旁白声分离，同名稳定。
 * 不建角色卡；仍标 speakerUnresolved 供门禁/UI。
 */

import {
  MIMO_TTS_PRESET_VOICES,
  type AudiobookDialogueSegment,
  type MimoTtsPresetVoice,
} from "@ai-novel/shared/types/audiobook";

/** 路人池：避开常见默认旁白「茉莉」优先；哈希点名保证同章同名同声 */
const GUEST_PRESET_POOL: MimoTtsPresetVoice[] = [
  "苏打",
  "白桦",
  "冰糖",
  "Milo",
  "Dean",
  "Chloe",
  "Mia",
];

function isPreset(voice: string): voice is MimoTtsPresetVoice {
  return (MIMO_TTS_PRESET_VOICES as readonly string[]).includes(voice);
}

function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 「旁白」类无意义标签：真旁白 / 无名 quote orphan，不是可补 alias 的角色名。 */
export function isNarratorLikeSpeakerLabel(
  raw: string | null | undefined,
): boolean {
  const t = (raw ?? "").trim();
  return !t || t === "旁白" || t === "narrator";
}

/**
 * 无真实 speaker 名的 quote orphan：产品选择旁白声 + unresolved（进 cast 分母，不点路人）。
 * unresolvedSpeakerName / speakerLabel 任一为旁白类标签都算 nameless。
 */
export function isNamelessQuoteOrphanUnresolved(
  seg: Pick<
    AudiobookDialogueSegment,
    "speakerUnresolved" | "unresolvedSpeakerName" | "speakerLabel"
  >,
): boolean {
  if (!seg.speakerUnresolved) return false;
  const rawName = (seg.unresolvedSpeakerName ?? "").trim();
  if (rawName && !isNarratorLikeSpeakerLabel(rawName)) return false;
  return isNarratorLikeSpeakerLabel(seg.speakerLabel);
}

/**
 * 有名未匹配路人的稳定显示名（用于 guest 池哈希 / speakerKey / 警告文案）。
 * 排除旁白类标签；无有效名时返回 null。
 */
export function namedGuestSpeakerName(
  seg: Pick<
    AudiobookDialogueSegment,
    "speakerUnresolved" | "unresolvedSpeakerName" | "speakerLabel"
  >,
): string | null {
  if (!seg.speakerUnresolved) return null;
  if (isNamelessQuoteOrphanUnresolved(seg)) return null;
  const raw = (
    seg.unresolvedSpeakerName
    || seg.speakerLabel
    || ""
  ).trim();
  if (!raw || isNarratorLikeSpeakerLabel(raw)) return null;
  return raw;
}

/**
 * 为 unresolved 说话人点一颗预置音色；尽量避开旁白当前 voice。
 */
export function pickGuestPresetVoice(
  unresolvedName: string | null | undefined,
  narratorVoice?: string | null,
): MimoTtsPresetVoice {
  const narr = (narratorVoice ?? "").trim();
  const pool = GUEST_PRESET_POOL.filter((v) => v !== narr);
  const use = pool.length > 0 ? pool : [...GUEST_PRESET_POOL];
  const key = (unresolvedName ?? "").trim() || "guest";
  return use[hashName(key) % use.length]!;
}

export function guestStyleForUnresolvedName(
  unresolvedName: string | null | undefined,
): string {
  const n = (unresolvedName ?? "").trim() || "路人";
  return `路人角色「${n.slice(0, 12)}」，吐字清楚，语速中等，与旁白可辨，不做主角声。`;
}

/** 供单测：池是否全在官方 preset 表内 */
export function guestPresetPoolForTest(): readonly MimoTtsPresetVoice[] {
  return GUEST_PRESET_POOL.filter(isPreset);
}
