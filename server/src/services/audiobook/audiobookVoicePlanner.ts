import {
  type AudiobookTtsMode,
  type AudiobookVoicePlanItem,
  type AudiobookVoicePlanStrategy,
  type MimoTtsPresetVoice,
} from "@ai-novel/shared/types/audiobook";

export type VoiceGenderBucket = "male" | "female" | "unknown";
export type VoiceAgeBucket = "youth" | "adult" | "elder" | "unknown";
export type VoicePitchBand = "high" | "mid" | "low";
export type VoiceTextureBand = "bright" | "neutral" | "dark_raspy" | "airy";
export type VoiceEnergyBand = "lively" | "even" | "heavy";

export interface VoicePlannerCharacterInput {
  characterId: string;
  characterName: string;
  gender?: string | null;
  castRole?: string | null;
  role?: string | null;
  personality?: string | null;
  voiceTexture?: string | null;
  appearance?: string | null;
  background?: string | null;
  storyFunction?: string | null;
  firstImpression?: string | null;
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  ttsSpeakerAliases?: string | string[] | null;
}

export interface VoiceSlot {
  pitchBand: VoicePitchBand;
  textureBand: VoiceTextureBand;
  energyBand: VoiceEnergyBand;
}

/** 中文预置池：按性别与年龄优先排序 */
const FEMALE_YOUTH: MimoTtsPresetVoice[] = ["冰糖", "茉莉"];
const FEMALE_ADULT: MimoTtsPresetVoice[] = ["茉莉", "冰糖"];
const MALE_YOUTH: MimoTtsPresetVoice[] = ["苏打", "白桦"];
const MALE_ADULT: MimoTtsPresetVoice[] = ["白桦", "苏打"];
const UNKNOWN_POOL: MimoTtsPresetVoice[] = ["茉莉", "苏打", "白桦", "冰糖"];

const FEMALE_HINT =
  /女|她|姑娘|小姐|少女|少妇|美女|娘|姐|妹|阿姨|婆婆|夫人|妃|公主|皇后|妈|娘子|寡妇|女士|female|woman|girl|lady/i;
const MALE_HINT =
  /男|他|公子|少爷|少年|小伙|大叔|爷|哥|弟|叔|伯|丈|王爷|将军|师傅|老师|爸|父|male|man|boy|guy/i;
const YOUTH_HINT =
  /少年|少女|年轻|青年|孩|童|小学|中学|青春|青涩|稚|学生|youth|teen|young|child/i;
const ELDER_HINT =
  /老|暮|苍|霜|中年|大叔|阿姨|长辈|前辈|elder|old|senior|middle.?aged/i;
const ROUGH_HINT = /沙哑|低沉|沉稳|冷硬|阴|狠|粗|哑|沧桑|威严|肃|冷|暗|厚/i;
const BRIGHT_HINT = /清亮|甜|脆|活泼|软|温柔|明快|灵动|俏|软糯|轻快|亮/i;
const AIRY_HINT = /气声|气音|轻声|虚|飘|薄|细|柔弱|轻柔/i;
const HIGH_PITCH_HINT = /尖|高|细|脆|童|清亮|明亮/i;
const LOW_PITCH_HINT = /低|沉|厚|浑|深|哑|沧桑|威严/i;
const LIVELY_HINT = /活泼|灵动|俏|急|快|跳|热|亢|兴/i;
const HEAVY_HINT = /沉|稳|肃|重|压|冷硬|威|缓|慢/i;

const PITCH_ORDER: VoicePitchBand[] = ["mid", "low", "high"];
const TEXTURE_ORDER: VoiceTextureBand[] = ["neutral", "dark_raspy", "bright", "airy"];
const ENERGY_ORDER: VoiceEnergyBand[] = ["even", "heavy", "lively"];

const DESIGN_PROMPT_MAX = 480;

const PITCH_ZH: Record<VoicePitchBand, string> = {
  high: "偏高",
  mid: "中等",
  low: "偏低",
};
const TEXTURE_ZH: Record<VoiceTextureBand, string> = {
  bright: "明亮清脆",
  neutral: "中性干净",
  dark_raspy: "偏低略沙哑",
  airy: "偏气声轻柔",
};
const ENERGY_ZH: Record<VoiceEnergyBand, string> = {
  lively: "活泼有弹性",
  even: "平稳克制",
  heavy: "沉稳有分量",
};

/** 与 TEXTURE_ZH 对立的原句线索：槽位扰动后禁止再拼进【声线】 */
const TEXTURE_CONFLICT_HINTS: Record<VoiceTextureBand, RegExp> = {
  bright: /沙哑|低沉|沉稳|沧桑|粗|哑|暗|厚|冷硬|气声|虚|飘|薄|柔弱/,
  neutral: /沙哑|清亮|甜|脆|气声|虚|飘|明快|软糯/,
  dark_raspy: /清亮|甜|脆|明快|灵动|俏|软糯|气声|虚|飘|明亮/,
  airy: /沙哑|低沉|沉稳|沧桑|粗|哑|厚|威严|冷硬|浑/,
};

export function isCharacterVoiceConfigured(input: {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
}): boolean {
  const mode = (input.ttsMode?.trim() || "preset") as AudiobookTtsMode | string;
  if (mode === "design") {
    return Boolean(input.ttsDesignPrompt?.trim());
  }
  if (mode === "clone") {
    return Boolean(input.ttsRefAudioPath?.trim());
  }
  return Boolean(input.ttsVoice?.trim());
}

export function inferGenderBucket(input: VoicePlannerCharacterInput): VoiceGenderBucket {
  const gender = (input.gender ?? "").trim().toLowerCase();
  if (gender === "female" || gender === "f") return "female";
  if (gender === "male" || gender === "m") return "male";

  const blob = [
    input.characterName,
    input.role,
    input.castRole,
    input.personality,
    input.voiceTexture,
    input.appearance,
    input.background,
    input.firstImpression,
    input.storyFunction,
  ]
    .filter(Boolean)
    .join(" ");

  const female = FEMALE_HINT.test(blob);
  const male = MALE_HINT.test(blob);
  if (female && !male) return "female";
  if (male && !female) return "male";
  return "unknown";
}

export function inferAgeBucket(input: VoicePlannerCharacterInput): VoiceAgeBucket {
  const blob = [
    input.characterName,
    input.role,
    input.personality,
    input.voiceTexture,
    input.appearance,
    input.background,
    input.firstImpression,
  ]
    .filter(Boolean)
    .join(" ");
  if (ELDER_HINT.test(blob)) return "elder";
  if (YOUTH_HINT.test(blob)) return "youth";
  return "adult";
}

export function scoreImportance(input: VoicePlannerCharacterInput): number {
  let score = 30;
  const cast = (input.castRole ?? "").trim().toLowerCase();
  const role = (input.role ?? "").trim();
  if (cast === "protagonist" || /主角|主人公/.test(role)) score += 50;
  else if (cast === "antagonist" || /反派|对手|BOSS|boss/.test(role)) score += 40;
  else if (cast === "love_interest" || /女主|男主|爱人|情/.test(role)) score += 35;
  else if (cast === "mentor" || /师父|导师|老师/.test(role)) score += 25;
  else if (cast === "ally" || /伙伴|兄弟|闺蜜/.test(role)) score += 20;
  else if (cast === "foil" || cast === "catalyst" || cast === "pressure_source") score += 15;

  if (input.voiceTexture?.trim()) score += 8;
  if (input.personality?.trim()) score += 5;
  if (input.background?.trim()) score += 3;
  return Math.max(0, Math.min(100, score));
}

function characterBlob(input: VoicePlannerCharacterInput): string {
  return [
    input.voiceTexture,
    input.personality,
    input.firstImpression,
    input.appearance,
    input.role,
    input.background,
  ]
    .filter(Boolean)
    .join("；");
}

/** 从卡字段启发式推断默认声线槽（prompt 约束，非声学证明）。 */
export function inferVoiceSlot(input: VoicePlannerCharacterInput): VoiceSlot {
  const blob = characterBlob(input);
  let pitchBand: VoicePitchBand = "mid";
  if (LOW_PITCH_HINT.test(blob) && !HIGH_PITCH_HINT.test(blob)) pitchBand = "low";
  else if (HIGH_PITCH_HINT.test(blob) && !LOW_PITCH_HINT.test(blob)) pitchBand = "high";

  let textureBand: VoiceTextureBand = "neutral";
  if (AIRY_HINT.test(blob)) textureBand = "airy";
  else if (ROUGH_HINT.test(blob)) textureBand = "dark_raspy";
  else if (BRIGHT_HINT.test(blob)) textureBand = "bright";

  let energyBand: VoiceEnergyBand = "even";
  if (HEAVY_HINT.test(blob) && !LIVELY_HINT.test(blob)) energyBand = "heavy";
  else if (LIVELY_HINT.test(blob)) energyBand = "lively";

  return { pitchBand, textureBand, energyBand };
}

export function slotKey(gender: VoiceGenderBucket, slot: VoiceSlot): string {
  return `${gender}|${slot.pitchBand}|${slot.textureBand}|${slot.energyBand}`;
}

export function slotsEqual(a: VoiceSlot, b: VoiceSlot): boolean {
  return (
    a.pitchBand === b.pitchBand
    && a.textureBand === b.textureBand
    && a.energyBand === b.energyBand
  );
}

/**
 * 从已写入的 design prompt 反解析槽位标签（onlyMissing seed 用）。
 * 匹配失败返回 null，调用方回退 inferVoiceSlot。
 */
export function parseSlotFromDesignPrompt(prompt: string): VoiceSlot | null {
  const text = prompt.trim();
  if (!text) return null;

  let pitchBand: VoicePitchBand | null = null;
  let textureBand: VoiceTextureBand | null = null;
  let energyBand: VoiceEnergyBand | null = null;

  for (const band of PITCH_ORDER) {
    if (text.includes(`音高${PITCH_ZH[band]}`)) {
      pitchBand = band;
      break;
    }
  }
  for (const band of TEXTURE_ORDER) {
    if (text.includes(`质感${TEXTURE_ZH[band]}`)) {
      textureBand = band;
      break;
    }
  }
  for (const band of ENERGY_ORDER) {
    if (text.includes(`气息${ENERGY_ZH[band]}`)) {
      energyBand = band;
      break;
    }
  }

  if (!pitchBand || !textureBand || !energyBand) {
    return null;
  }
  return { pitchBand, textureBand, energyBand };
}

/**
 * 在已占用集合中找空闲槽；池尽则 soft 占用原槽。
 * 扰动优先级：texture → pitch → energy（与开发计划一致）。
 */
export function allocateVoiceSlot(input: {
  gender: VoiceGenderBucket;
  preferred: VoiceSlot;
  occupied: Set<string>;
}): { slot: VoiceSlot; key: string; softCollision: boolean } {
  const trySlot = (slot: VoiceSlot) => {
    const key = slotKey(input.gender, slot);
    return { slot, key, free: !input.occupied.has(key) };
  };

  const preferred = trySlot(input.preferred);
  if (preferred.free) {
    return { slot: preferred.slot, key: preferred.key, softCollision: false };
  }

  for (const textureBand of TEXTURE_ORDER) {
    const candidate = trySlot({ ...input.preferred, textureBand });
    if (candidate.free) {
      return { slot: candidate.slot, key: candidate.key, softCollision: false };
    }
  }

  for (const pitchBand of PITCH_ORDER) {
    for (const textureBand of TEXTURE_ORDER) {
      const candidate = trySlot({ ...input.preferred, pitchBand, textureBand });
      if (candidate.free) {
        return { slot: candidate.slot, key: candidate.key, softCollision: false };
      }
    }
  }

  for (const energyBand of ENERGY_ORDER) {
    for (const pitchBand of PITCH_ORDER) {
      for (const textureBand of TEXTURE_ORDER) {
        const candidate = trySlot({ pitchBand, textureBand, energyBand });
        if (candidate.free) {
          return { slot: candidate.slot, key: candidate.key, softCollision: false };
        }
      }
    }
  }

  // 池尽：soft 冲突，仍写原 preferred，reason 由调用方标记
  return { slot: preferred.slot, key: preferred.key, softCollision: true };
}

function ageLabel(age: VoiceAgeBucket): string {
  if (age === "youth") return "偏年轻";
  if (age === "elder") return "偏年长";
  return "青壮年";
}

function genderLabel(gender: VoiceGenderBucket): string {
  if (gender === "female") return "女性";
  if (gender === "male") return "男性";
  return "中性偏柔";
}

function textureConflictsWithSlot(textureCore: string, textureBand: VoiceTextureBand): boolean {
  return TEXTURE_CONFLICT_HINTS[textureBand].test(textureCore);
}

/**
 * 结构化 design prompt。
 * - 槽位自然语言为【声线】主信号
 * - voiceTexture 仅在与槽位一致且无对立词时并入；槽位扰动后禁止裸拼原句（避免「明亮+沙哑」）
 * - 截断优先级：声线 > 互斥 > 身份 > 表达 > 禁止 > 气质
 */
export function buildDesignPrompt(input: {
  character: VoicePlannerCharacterInput;
  gender: VoiceGenderBucket;
  age: VoiceAgeBucket;
  slot: VoiceSlot;
  preferredSlot?: VoiceSlot;
  softCollision?: boolean;
  neighborSlotLabel?: string | null;
}): string {
  const { character, gender, age, slot } = input;
  const name = character.characterName.slice(0, 24);
  const roleBit = (character.role || character.castRole || "配角").toString().slice(0, 32);
  const personality = (character.personality || character.firstImpression || "").trim().slice(0, 72);
  const textureCore = character.voiceTexture?.trim() || "";
  const preferred = input.preferredSlot ?? inferVoiceSlot(character);
  const slotDiverged = !slotsEqual(preferred, slot);

  const voiceParts = [
    `音高${PITCH_ZH[slot.pitchBand]}`,
    `质感${TEXTURE_ZH[slot.textureBand]}`,
    `气息${ENERGY_ZH[slot.energyBand]}`,
  ];
  // 槽位与卡一致且原句不与槽位对立时，才并入 texture 原句
  if (
    textureCore
    && !slotDiverged
    && !textureConflictsWithSlot(textureCore, slot.textureBand)
  ) {
    voiceParts.push(textureCore.slice(0, 200));
  } else if (textureCore && slotDiverged) {
    // 扰动后：只保留极短非对立片段作审计，绝不整段粘贴
    const clipped = textureCore.slice(0, 24);
    if (!textureConflictsWithSlot(clipped, slot.textureBand)) {
      voiceParts.push(`（卡面线索：${clipped}）`);
    }
  }

  const mutexParts = [
    "与同书其他角色在音高/质感上可辨",
    "避免播音腔与无特征标准青年声",
  ];
  if (input.softCollision && input.neighborSlotLabel) {
    mutexParts.unshift(`明显区别于${input.neighborSlotLabel}`);
  }

  const identity = `【身份】${ageLabel(age)}${genderLabel(gender)}，叙事身份：${roleBit}「${name}」`;
  const voice = `【声线】${voiceParts.join("，")}`;
  // 槽位扰动时把完整 texture 挪到气质侧，避免【声线】自相矛盾
  const vibeBits = [personality];
  if (slotDiverged && textureCore) {
    vibeBits.push(`卡面声线原文：${textureCore.slice(0, 48)}`);
  }
  const vibeJoined = vibeBits.filter(Boolean).join("；").slice(0, 96);
  const vibe = vibeJoined ? `【气质】${vibeJoined}` : "";
  const express = "【表达】语速中等，吐字清楚，适合小说对白；中文普通话";
  const mutex = `【互斥】${mutexParts.join("；")}`;
  const forbid = "【禁止】不要模仿旁白；不要空壳「标准男/女声」";

  // 阅读顺序组装；超长时按优先级丢弃气质→禁止→表达→身份，尽量保留声线与互斥
  const ordered = [identity, voice, vibe, express, mutex, forbid].filter(Boolean);
  let prompt = ordered.join("\n");
  if (prompt.length <= DESIGN_PROMPT_MAX) {
    return prompt;
  }

  const dropOrder = [vibe, forbid, express, identity];
  const active = new Set(ordered);
  for (const drop of dropOrder) {
    if (!drop || prompt.length <= DESIGN_PROMPT_MAX) break;
    active.delete(drop);
    prompt = [identity, voice, vibe, express, mutex, forbid]
      .filter((part) => part && active.has(part))
      .join("\n");
  }

  if (prompt.length <= DESIGN_PROMPT_MAX) {
    return prompt;
  }

  // 仍超长：保声线+互斥
  const hard = [voice, mutex].join("\n");
  if (hard.length <= DESIGN_PROMPT_MAX) {
    return hard;
  }
  const mutexBlock = `\n${mutex}`;
  const room = Math.max(24, DESIGN_PROMPT_MAX - mutexBlock.length);
  return `${voice.slice(0, room)}${mutexBlock}`.slice(0, DESIGN_PROMPT_MAX);
}

function buildStyle(
  input: VoicePlannerCharacterInput,
  slot?: VoiceSlot,
  options?: { preferSlot?: boolean },
): string {
  if (options?.preferSlot && slot) {
    return `音高${PITCH_ZH[slot.pitchBand]}，质感${TEXTURE_ZH[slot.textureBand]}，吐字清楚，语速中等。`.slice(0, 200);
  }
  const texture = input.voiceTexture?.trim();
  if (texture) {
    return texture.slice(0, 200);
  }
  if (slot) {
    return `音高${PITCH_ZH[slot.pitchBand]}，质感${TEXTURE_ZH[slot.textureBand]}，吐字清楚，语速中等。`.slice(0, 200);
  }
  const personality = input.personality?.trim();
  if (personality) {
    return `符合角色气质：${personality.slice(0, 120)}。吐字清楚，语速中等。`.slice(0, 200);
  }
  return "符合角色身份，吐字清楚，语速中等，情绪自然。";
}

function presetPool(gender: VoiceGenderBucket, age: VoiceAgeBucket): MimoTtsPresetVoice[] {
  if (gender === "female") {
    return age === "youth" ? [...FEMALE_YOUTH] : [...FEMALE_ADULT];
  }
  if (gender === "male") {
    return age === "youth" ? [...MALE_YOUTH] : [...MALE_ADULT];
  }
  return [...UNKNOWN_POOL];
}

function pickLeastUsedPreset(
  pool: MimoTtsPresetVoice[],
  usage: Map<string, number>,
): MimoTtsPresetVoice {
  let best = pool[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const voice of pool) {
    const count = usage.get(voice) ?? 0;
    if (count < bestCount) {
      best = voice;
      bestCount = count;
    }
  }
  return best;
}

function seedPresetUsage(
  usage: Map<string, number>,
  importantUsage: Map<string, number>,
  character: VoicePlannerCharacterInput,
): void {
  const mode = character.ttsMode?.trim() || "preset";
  const voice = character.ttsVoice?.trim() || "";
  if (mode !== "preset" || !voice) {
    return;
  }
  usage.set(voice, (usage.get(voice) ?? 0) + 1);
  if (scoreImportance(character) >= 55) {
    importantUsage.set(voice, (importantUsage.get(voice) ?? 0) + 1);
  }
}

/** onlyMissing：已绑定 design 占用槽位，避免新角撞上旧 design prompt 维 */
function seedBoundDesignSlot(
  occupiedSlots: Set<string>,
  occupiedSlotByKey: Map<string, VoiceSlot>,
  character: VoicePlannerCharacterInput,
): void {
  const mode = character.ttsMode?.trim() || "preset";
  if (mode !== "design" || !character.ttsDesignPrompt?.trim()) {
    return;
  }
  const gender = inferGenderBucket(character);
  const slot =
    parseSlotFromDesignPrompt(character.ttsDesignPrompt)
    ?? inferVoiceSlot(character);
  const key = slotKey(gender, slot);
  occupiedSlots.add(key);
  if (!occupiedSlotByKey.has(key)) {
    occupiedSlotByKey.set(key, slot);
  }
}

function markSlotOccupied(
  occupiedSlots: Set<string>,
  occupiedSlotByKey: Map<string, VoiceSlot>,
  key: string,
  slot: VoiceSlot,
): void {
  occupiedSlots.add(key);
  // soft 碰撞时 key 已存在：保留先占者，邻居标签才能指向真实占用槽
  if (!occupiedSlotByKey.has(key)) {
    occupiedSlotByKey.set(key, slot);
  }
}

function neighborLabel(slot: VoiceSlot): string {
  return `${PITCH_ZH[slot.pitchBand]}${TEXTURE_ZH[slot.textureBand]}声线`;
}

/**
 * 纯函数：根据人物卡批量规划差异化音色。
 * - prefer_design：非 clone 全 design + 槽位 prompt 防撞
 * - auto（保守）：importance≥70 且有 voiceTexture → design；重要 preset 位满 → design；其余 preset
 * - preset_only：仅 preset 负载均衡
 * - clone 永不改写
 * - 覆盖语义由调用方 onlyMissing + apply.overwrite 处理（本函数不接收 overwrite）
 */
export function planCharacterVoices(input: {
  characters: VoicePlannerCharacterInput[];
  strategy?: AudiobookVoicePlanStrategy;
  onlyMissing?: boolean;
  characterIds?: string[];
  maxImportantPerPreset?: number;
}): {
  items: AudiobookVoicePlanItem[];
  skipped: Array<{ characterId: string; characterName: string; reason: string }>;
} {
  const strategy: AudiobookVoicePlanStrategy = input.strategy ?? "auto";
  const onlyMissing = input.onlyMissing !== false;
  const maxImportantPerPreset = Math.max(1, input.maxImportantPerPreset ?? 1);
  const allowIds = input.characterIds?.length
    ? new Set(input.characterIds)
    : null;

  const skipped: Array<{ characterId: string; characterName: string; reason: string }> = [];
  const candidates: Array<
    VoicePlannerCharacterInput & {
      genderBucket: VoiceGenderBucket;
      ageBucket: VoiceAgeBucket;
      importance: number;
      configured: boolean;
      preferredSlot: VoiceSlot;
    }
  > = [];
  const usage = new Map<string, number>();
  const importantUsage = new Map<string, number>();
  const occupiedSlots = new Set<string>();
  const occupiedSlotByKey = new Map<string, VoiceSlot>();

  for (const character of input.characters) {
    if (allowIds && !allowIds.has(character.characterId)) {
      continue;
    }

    const mode = character.ttsMode?.trim() || "preset";
    const cloneBound = mode === "clone" && Boolean(character.ttsRefAudioPath?.trim());
    if (cloneBound) {
      skipped.push({
        characterId: character.characterId,
        characterName: character.characterName,
        reason: "已配置 clone 参考音频。",
      });
      continue;
    }

    const configured = isCharacterVoiceConfigured(character);
    if (onlyMissing && configured) {
      seedPresetUsage(usage, importantUsage, character);
      seedBoundDesignSlot(occupiedSlots, occupiedSlotByKey, character);
      skipped.push({
        characterId: character.characterId,
        characterName: character.characterName,
        reason: "已绑定音色（onlyMissing=true）。",
      });
      continue;
    }

    candidates.push({
      ...character,
      genderBucket: inferGenderBucket(character),
      ageBucket: inferAgeBucket(character),
      importance: scoreImportance(character),
      configured,
      preferredSlot: inferVoiceSlot(character),
    });
  }

  candidates.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return a.characterName.localeCompare(b.characterName, "zh");
  });

  const items: AudiobookVoicePlanItem[] = [];

  for (const character of candidates) {
    const pool = presetPool(character.genderBucket, character.ageBucket);
    let ttsMode: AudiobookTtsMode = "preset";
    let ttsVoice: string | null = null;
    let ttsDesignPrompt: string | null = null;
    let reason = "";
    let designSlot: VoiceSlot | null = null;
    let softCollision = false;

    const hasTexture = Boolean(character.voiceTexture?.trim());
    // auto 保守：importance≥70 且有 texture → design（删除内层 ≥80 死区）
    const autoDesignByTexture = strategy === "auto" && character.importance >= 70 && hasTexture;

    if (strategy === "prefer_design" || autoDesignByTexture) {
      ttsMode = "design";
      reason = strategy === "prefer_design"
        ? "策略 prefer_design：按人物卡生成 design 描述。"
        : "auto：高重要性且有 voiceTexture，用 design 保证声线辨识度。";
    }

    if (ttsMode === "preset") {
      const voice = pickLeastUsedPreset(pool, usage);
      const importantCount = importantUsage.get(voice) ?? 0;
      const isImportant = character.importance >= 55;

      if (
        strategy !== "preset_only"
        && isImportant
        && importantCount >= maxImportantPerPreset
      ) {
        ttsMode = "design";
        reason = `预置「${voice}」重要角色已满，升 design 避免撞声。`;
      } else {
        ttsMode = "preset";
        ttsVoice = voice;
        usage.set(voice, (usage.get(voice) ?? 0) + 1);
        if (isImportant) {
          importantUsage.set(voice, importantCount + 1);
        }
        reason = `按${character.genderBucket}/${character.ageBucket}分配预置「${voice}」，负载均衡。`;
      }
    }

    if (ttsMode === "design") {
      const allocated = allocateVoiceSlot({
        gender: character.genderBucket,
        preferred: character.preferredSlot,
        occupied: occupiedSlots,
      });
      designSlot = allocated.slot;
      softCollision = allocated.softCollision;

      const neighborSlot = softCollision
        ? occupiedSlotByKey.get(allocated.key) ?? null
        : null;
      const neighbor = neighborSlot ? neighborLabel(neighborSlot) : null;
      const slotDiverged = !slotsEqual(character.preferredSlot, allocated.slot);

      ttsDesignPrompt = buildDesignPrompt({
        character,
        gender: character.genderBucket,
        age: character.ageBucket,
        slot: allocated.slot,
        preferredSlot: character.preferredSlot,
        softCollision,
        neighborSlotLabel: softCollision ? neighbor : null,
      });

      markSlotOccupied(occupiedSlots, occupiedSlotByKey, allocated.key, allocated.slot);

      if (softCollision) {
        reason = `${reason} collision:soft`.trim();
      } else if (slotDiverged) {
        reason = `${reason} slot:override ${allocated.key}。`.trim();
      } else if (!reason.includes("槽") && strategy === "prefer_design") {
        reason = `${reason} 槽位 ${allocated.key}。`.trim();
      }
    }

    items.push({
      characterId: character.characterId,
      characterName: character.characterName,
      ttsMode,
      ttsVoice,
      ttsStyle: buildStyle(
        character,
        designSlot ?? character.preferredSlot,
        { preferSlot: ttsMode === "design" },
      ),
      ttsDesignPrompt,
      speakerAliases: null,
      wouldOverwrite: character.configured,
      reason,
      genderBucket: character.genderBucket,
      ageBucket: character.ageBucket,
      importance: character.importance,
      currentBinding: {
        ttsMode: character.ttsMode ?? null,
        ttsVoice: character.ttsVoice ?? null,
        ttsDesignPrompt: character.ttsDesignPrompt ?? null,
      },
    });
  }

  return { items, skipped };
}
