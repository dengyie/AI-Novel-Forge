/**
 * 未匹配角色卡时的「路人」预置音色：与旁白声分离，同名稳定。
 * 不建角色卡；仍标 speakerUnresolved 供门禁/UI。
 */

import {
  MIMO_TTS_PRESET_VOICES,
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
