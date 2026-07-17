import {
  type AudiobookTtsMode,
  type AudiobookVoicePlanItem,
  type AudiobookVoicePlanStrategy,
  type MimoTtsPresetVoice,
  isMimoTtsPresetVoice,
} from "@ai-novel/shared/types/audiobook";
import { pickDesignPromptArchetype } from "./designPromptArchetypes";

export type VoiceGenderBucket = "male" | "female" | "unknown";
export type VoiceAgeBucket = "youth" | "adult" | "elder" | "unknown";
export type VoicePitchBand = "high" | "mid" | "low";
export type VoiceTextureBand = "bright" | "neutral" | "dark_raspy" | "airy";
export type VoiceEnergyBand = "lively" | "even" | "heavy";
/** 音色分簇：主角 / 主角团 / 路人 / 旁白（分配维，非听感证明） */
export type VoiceCluster = "lead" | "cast" | "extra" | "narrator";

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
const ROUGH_HINT = /沙哑|略沙|偏沙|带沙|沙质|低沉|沉稳|冷硬|阴冷|阴狠|狠|粗|哑|沧桑|威严|肃|暗沉|厚重|厚实/i;
const BRIGHT_HINT = /清亮|甜|脆|活泼|软|温柔|明快|灵动|俏|软糯|轻快|亮/i;
const AIRY_HINT = /气声|气音|轻声|虚|飘|薄|细|柔弱|轻柔/i;
const HIGH_PITCH_HINT = /尖|高|细|脆|童|清亮|明亮/i;
const LOW_PITCH_HINT = /低|沉|厚|浑|深|哑|沧桑|威严/i;
const LIVELY_HINT = /活泼|灵动|俏|急|快|跳|热|亢|兴/i;
const HEAVY_HINT = /沉|稳|肃|重|压|冷硬|威|缓|慢/i;

const PITCH_ORDER: VoicePitchBand[] = ["mid", "low", "high"];
const TEXTURE_ORDER: VoiceTextureBand[] = ["neutral", "dark_raspy", "bright", "airy"];
const ENERGY_ORDER: VoiceEnergyBand[] = ["even", "heavy", "lively"];

/** identity design 硬顶；须为 delivery 合并预留余量（MIMO_USER_MAX=280） */
export const DESIGN_PROMPT_MAX = 200;
/** 组装目标区间（软目标，硬顶仍为 DESIGN_PROMPT_MAX） */
export const DESIGN_PROMPT_TARGET_MIN = 120;
export const DESIGN_PROMPT_TARGET_MAX = 160;

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

/** 与 TEXTURE_ZH 对立的原句线索：槽位扰动后禁止再拼进身份文案 flavor */
const TEXTURE_CONFLICT_HINTS: Record<VoiceTextureBand, RegExp> = {
  bright: /沙哑|低沉|沉稳|沧桑|粗|哑|暗|厚|冷硬|气声|虚|飘|薄|柔弱/,
  neutral: /沙哑|气声|虚|飘|软糯|过甜|过亮刺耳/,
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

/**
 * role 是否像「本书主角」标签（分配维）。
 * 排除：主角的父亲、女主/女主角（进 cast）、配角含「主角」从属等。
 */
export function isLeadRoleText(role: string): boolean {
  const r = role.trim();
  if (!r) return false;
  // 从属/亲属：主角的父亲、主人公之师
  if (/主角的|主人公的|之主角|配角/.test(r)) return false;
  // 女主线标签：与男主并列时归 cast（design 仍可进主角团），避免双 lead 抢槽
  if (/女主|女主人公|heroine/i.test(r) && !/男主/.test(r)) return false;
  // 精确/常见标签
  if (/^(本书)?主角$|^主人公$|^男主$|^男主角$|^male\s*lead$/i.test(r)) return true;
  // 分隔词边界上的「主角」「主人公」（非「女主角」：女+主角无边界）
  if (/(?:^|[,，、；\s/|])主角(?:$|[,，、；\s/|])/.test(r)) return true;
  if (/(?:^|[,，、；\s/|])主人公(?:$|[,，、；\s/|])/.test(r)) return true;
  // 以「主角」收尾且非女主角：如「废柴主角」
  if (/主角$/.test(r) && !/女主角$/.test(r)) return true;
  return false;
}

export function scoreImportance(input: VoicePlannerCharacterInput): number {
  let score = 30;
  const cast = (input.castRole ?? "").trim().toLowerCase();
  const role = (input.role ?? "").trim();
  if (cast === "protagonist" || isLeadRoleText(role)) score += 50;
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

const CAST_ROLES = new Set([
  "antagonist",
  "love_interest",
  "mentor",
  "ally",
  "foil",
  "catalyst",
  "pressure_source",
]);

/**
 * 分簇（分配维）：
 * - lead：主角（castRole=protagonist 或 isLeadRoleText）
 * - cast：主角团 / 高戏份
 * - extra：路人
 * - narrator：旁白（角色卡若标旁白则走旁白 preset 簇；系统旁白仍在 pipeline 外）
 */
export function resolveVoiceCluster(input: VoicePlannerCharacterInput): VoiceCluster {
  const cast = (input.castRole ?? "").trim().toLowerCase();
  const role = (input.role ?? "").trim();
  const name = (input.characterName ?? "").trim();
  if (
    cast === "narrator"
    || /旁白|narrator/i.test(role)
    || /旁白|narrator/i.test(name)
  ) {
    return "narrator";
  }
  if (cast === "protagonist" || isLeadRoleText(role)) {
    return "lead";
  }
  const importance = scoreImportance(input);
  if (CAST_ROLES.has(cast) || importance >= 50) {
    // 显式路人 role 且分数不高：仍归 extra，避免「路人甲」误进主角团
    if (importance < 55 && /路人|群众|店小二|侍卫|士兵|npc|路人甲|路人乙/i.test(role)) {
      return "extra";
    }
    return "cast";
  }
  return "extra";
}

/** 声学线索：只吃声线/外形，避免 personality「冷静」误进 texture。 */
function acousticBlob(input: VoicePlannerCharacterInput): string {
  return [input.voiceTexture, input.appearance].filter(Boolean).join("；");
}

/** 气质/能量线索：personality / 印象 / 角色标签。 */
function mannerBlob(input: VoicePlannerCharacterInput): string {
  return [input.personality, input.firstImpression, input.role, input.castRole]
    .filter(Boolean)
    .join("；");
}

function inferTextureBandFromText(text: string): VoiceTextureBand {
  if (!text.trim()) return "neutral";
  if (AIRY_HINT.test(text)) return "airy";
  if (ROUGH_HINT.test(text)) return "dark_raspy";
  if (BRIGHT_HINT.test(text)) return "bright";
  return "neutral";
}

/**
 * 从卡字段启发式推断默认声线槽（prompt 约束，非声学证明）。
 * - pitch/texture：仅 acoustic（voiceTexture 优先）
 * - energy：manner + acoustic；lead 默认抬 heavy 忌死气
 * - 有 voiceTexture 时 textureBand 视为可锁定（allocate preserveTexture）
 */
export function inferVoiceSlot(input: VoicePlannerCharacterInput): VoiceSlot {
  const textureField = (input.voiceTexture || "").trim();
  const acoustic = acousticBlob(input);
  const manner = mannerBlob(input);
  const pitchSource = acoustic || manner;
  const energySource = [acoustic, manner].filter(Boolean).join("；");

  let pitchBand: VoicePitchBand = "mid";
  if (LOW_PITCH_HINT.test(pitchSource) && !HIGH_PITCH_HINT.test(pitchSource)) pitchBand = "low";
  else if (HIGH_PITCH_HINT.test(pitchSource) && !LOW_PITCH_HINT.test(pitchSource)) pitchBand = "high";

  // texture：有 voiceTexture 时只读该字段，禁止 personality 污染
  const textureBand = textureField
    ? inferTextureBandFromText(textureField)
    : inferTextureBandFromText(acoustic);

  let energyBand: VoiceEnergyBand = "even";
  if (HEAVY_HINT.test(energySource) && !LIVELY_HINT.test(energySource)) energyBand = "heavy";
  else if (LIVELY_HINT.test(energySource)) energyBand = "lively";

  const cluster = resolveVoiceCluster(input);
  if (cluster === "lead" && energyBand === "even" && !LIVELY_HINT.test(energySource)) {
    energyBand = "heavy";
  }

  return { pitchBand, textureBand, energyBand };
}

/** 卡面是否写了可锁定的声线字段（allocate 优先保 textureBand）。 */
export function hasLockableVoiceTexture(input: VoicePlannerCharacterInput): boolean {
  return Boolean(input.voiceTexture?.trim());
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
 * 槽距：pitch 差 + texture 差 + energy 差（0–3）。
 * lead/cast 分配时优先与已占 design 槽拉开 ≥2 维（分配维，非听感证明）。
 */
export function slotDistance(a: VoiceSlot, b: VoiceSlot): number {
  let d = 0;
  if (a.pitchBand !== b.pitchBand) d += 1;
  if (a.textureBand !== b.textureBand) d += 1;
  if (a.energyBand !== b.energyBand) d += 1;
  return d;
}

function minDistanceToOccupied(
  gender: VoiceGenderBucket,
  slot: VoiceSlot,
  occupiedSlotByKey: Map<string, VoiceSlot> | undefined,
): number {
  if (!occupiedSlotByKey || occupiedSlotByKey.size === 0) {
    return 3;
  }
  let min = 3;
  for (const [key, other] of occupiedSlotByKey) {
    if (!key.startsWith(`${gender}|`)) continue;
    min = Math.min(min, slotDistance(slot, other));
    if (min === 0) return 0;
  }
  return min;
}

/**
 * 在已占用集合中找空闲槽；池尽则 soft 占用原槽。
 * 扰动优先级：texture → pitch → energy（与开发计划一致）。
 * lead/cast 可要求 minSeparation（默认 0；分簇 v2 用 2）相对已占同性别 design 槽。
 *
 * soft 语义锁：池尽时必须仍返回 preferred.key（已被占的键），
 * 以便调用方用 occupiedSlotByKey.get(preferred.key) 解析真实先占邻居。
 * 禁止 soft 时改写为「随机空键」或新造 key。
 */
export function allocateVoiceSlot(input: {
  gender: VoiceGenderBucket;
  preferred: VoiceSlot;
  occupied: Set<string>;
  /** 已占槽位 map；提供时才做 minSeparation 约束 */
  occupiedSlotByKey?: Map<string, VoiceSlot>;
  /** 与同性别已占 design 的最小维差；0=仅 key 不撞 */
  minSeparation?: number;
  /**
   * 有卡面 voiceTexture 时优先保 textureBand：
   * 先拧 pitch/energy，texture 扰动放到最后（辨识度 > 纯槽距）。
   */
  preserveTexture?: boolean;
}): { slot: VoiceSlot; key: string; softCollision: boolean } {
  const minSep = Math.max(0, Math.min(3, input.minSeparation ?? 0));
  const preserveTexture = Boolean(input.preserveTexture);
  const trySlot = (slot: VoiceSlot) => {
    const key = slotKey(input.gender, slot);
    const free = !input.occupied.has(key);
    const sep = free
      ? minDistanceToOccupied(input.gender, slot, input.occupiedSlotByKey)
      : -1;
    return { slot, key, free, sep };
  };

  const preferred = trySlot(input.preferred);
  if (preferred.free && preferred.sep >= minSep) {
    return { slot: preferred.slot, key: preferred.key, softCollision: false };
  }

  const lockedTexture = input.preferred.textureBand;

  // 两轮：先满足 minSep，再降级为仅 key 不撞
  for (const requireSep of minSep > 0 ? [minSep, 0] : [0]) {
    if (preferred.free && preferred.sep >= requireSep) {
      return { slot: preferred.slot, key: preferred.key, softCollision: false };
    }

    if (preserveTexture) {
      // 1) 只改 pitch，保 texture+energy
      for (const pitchBand of PITCH_ORDER) {
        const candidate = trySlot({ ...input.preferred, pitchBand });
        if (candidate.free && candidate.sep >= requireSep) {
          return { slot: candidate.slot, key: candidate.key, softCollision: false };
        }
      }
      // 2) 只改 energy，保 texture
      for (const energyBand of ENERGY_ORDER) {
        const candidate = trySlot({ ...input.preferred, energyBand });
        if (candidate.free && candidate.sep >= requireSep) {
          return { slot: candidate.slot, key: candidate.key, softCollision: false };
        }
      }
      // 3) pitch+energy，仍保 texture
      for (const energyBand of ENERGY_ORDER) {
        for (const pitchBand of PITCH_ORDER) {
          const candidate = trySlot({
            pitchBand,
            textureBand: lockedTexture,
            energyBand,
          });
          if (candidate.free && candidate.sep >= requireSep) {
            return { slot: candidate.slot, key: candidate.key, softCollision: false };
          }
        }
      }
    }

    // 默认 / 保 texture 失败后的 fallback：texture → pitch → energy
    for (const textureBand of TEXTURE_ORDER) {
      const candidate = trySlot({ ...input.preferred, textureBand });
      if (candidate.free && candidate.sep >= requireSep) {
        return { slot: candidate.slot, key: candidate.key, softCollision: false };
      }
    }

    for (const pitchBand of PITCH_ORDER) {
      for (const textureBand of TEXTURE_ORDER) {
        const candidate = trySlot({ ...input.preferred, pitchBand, textureBand });
        if (candidate.free && candidate.sep >= requireSep) {
          return { slot: candidate.slot, key: candidate.key, softCollision: false };
        }
      }
    }

    for (const energyBand of ENERGY_ORDER) {
      for (const pitchBand of PITCH_ORDER) {
        for (const textureBand of TEXTURE_ORDER) {
          const candidate = trySlot({ pitchBand, textureBand, energyBand });
          if (candidate.free && candidate.sep >= requireSep) {
            return { slot: candidate.slot, key: candidate.key, softCollision: false };
          }
        }
      }
    }
  }

  return { slot: preferred.slot, key: preferred.key, softCollision: true };
}

export function textureConflictsWithSlot(textureCore: string, textureBand: VoiceTextureBand): boolean {
  return TEXTURE_CONFLICT_HINTS[textureBand].test(textureCore);
}

/**
 * 从卡面/archetype 短语中抽出与槽位不对立的片段（全有或全无 → 可保留子串）。
 * 按顿号/逗号切分，丢弃命中对立词表的 token。
 */
/** 对立关键词（用于局部剥离，比整句丢弃更保辨识度） */
const TEXTURE_CONFLICT_STRIP: Record<VoiceTextureBand, RegExp> = {
  bright: /沙哑|低沉|沉稳|沧桑|粗哑|粗|哑|暗沉|厚重|冷硬|气声|虚飘|柔弱/g,
  neutral: /沙哑|气声|虚飘|软糯|明快过头/g,
  dark_raspy: /清亮|甜腻|明快|灵动|俏皮|软糯|气声|虚飘|明亮清脆|明亮/g,
  airy: /沙哑|低沉|沉稳|沧桑|粗哑|粗|哑|厚重|威严|冷硬|浑厚/g,
};

export function extractCompatibleTextureSnippet(
  raw: string,
  textureBand: VoiceTextureBand,
  max = 28,
): string | null {
  const cleaned = compressTextureSnippet(raw, 120);
  if (!cleaned) return null;
  if (!textureConflictsWithSlot(cleaned, textureBand)) {
    return cleaned.slice(0, max);
  }
  // 1) 按分隔符保不冲突 token
  const tokens = cleaned
    .split(/[、，,；;\/|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const keptTokens = tokens.filter((t) => !textureConflictsWithSlot(t, textureBand));
  if (keptTokens.length > 0) {
    return keptTokens.join("、").slice(0, max);
  }
  // 2) 剥离对立关键词后保留残余（如「清亮稳、不甜腻」→ 去清亮 →「稳」；「不甜腻」保留）
  let stripped = cleaned.replace(TEXTURE_CONFLICT_STRIP[textureBand], "");
  // 「不X」里的 X 被剥掉后留下的「不」单独无意义
  stripped = stripped.replace(/不(?=[、，,；;]|$)/g, "").replace(/[、，,；;]{2,}/g, "、").replace(/^、|、$/g, "");
  stripped = stripped.replace(/\s+/g, "").trim();
  // 再清一次残留对立
  if (stripped && textureConflictsWithSlot(stripped, textureBand)) {
    stripped = stripped.replace(TEXTURE_CONFLICT_STRIP[textureBand], "").trim();
  }
  if (stripped.length >= 2 && !textureConflictsWithSlot(stripped, textureBand)) {
    return stripped.slice(0, max);
  }
  // 3) 兜底：中性描述不硬塞对立词
  return null;
}

/** 卡面是否已给出可用的角色/功能标签（有则不用 archetype useCase 覆盖） */
function hasRoleSignal(character: VoicePlannerCharacterInput): boolean {
  return Boolean(
    character.role?.trim()
    || character.castRole?.trim()
    || character.storyFunction?.trim(),
  );
}

/** 声线习惯短语：用于把 identity 填到软目标 120–160，不改三元。 */
export function speechHabitCandidates(slot: VoiceSlot, cluster: VoiceCluster): string[] {
  const habits: string[] = [];
  if (slot.textureBand === "bright") habits.push("咬字偏亮但不刺耳");
  if (slot.textureBand === "dark_raspy") habits.push("共鸣略靠后、不压喉");
  if (slot.textureBand === "airy") habits.push("气声收住、不虚飘");
  if (slot.textureBand === "neutral") habits.push("声线干净、无明显口音");
  if (slot.energyBand === "heavy") habits.push("日常语速偏稳，激动也不尖");
  if (slot.energyBand === "lively") habits.push("语速可略快，句尾轻扬");
  if (slot.energyBand === "even") habits.push("语速中等，收尾干净");
  if (cluster === "lead") habits.push("对白有角色重心，不演旁白");
  else if (cluster === "cast") habits.push("与主角声线可辨，不抢戏");
  return habits;
}

export type DesignTextureFlavorStatus =
  | "card-full"
  | "card-partial"
  | "card-dropped"
  | "archetype"
  | "none";

/**
 * Voice Design 身份文案（自然语言一段 + 可解析三元锚点）。
 * - 强制含：音高{PITCH_ZH} / 质感{TEXTURE_ZH} / 气息{ENERGY_ZH}（onlyMissing seed）
 * - 无【标签】主结构；默认不写角色专名
 * - softCollision 互斥首句 hard-keep；超长按优先级截断，硬顶 DESIGN_PROMPT_MAX
 * - 卡面 texture 与槽冲突时尽量保留非对立子串；软目标 120–160 用习惯短语填满
 */
export function buildDesignPrompt(input: {
  character: VoicePlannerCharacterInput;
  gender: VoiceGenderBucket;
  age: VoiceAgeBucket;
  slot: VoiceSlot;
  preferredSlot?: VoiceSlot;
  softCollision?: boolean;
  neighborSlotLabel?: string | null;
  cluster?: VoiceCluster;
  /** 弱卡 archetype 质感短语（阶段 2）；不得覆盖三元锚点 */
  archetypeTexturePhrase?: string | null;
  archetypeUseCase?: string | null;
}): string {
  return buildDesignPromptDetailed(input).prompt;
}

export function buildDesignPromptDetailed(input: {
  character: VoicePlannerCharacterInput;
  gender: VoiceGenderBucket;
  age: VoiceAgeBucket;
  slot: VoiceSlot;
  preferredSlot?: VoiceSlot;
  softCollision?: boolean;
  neighborSlotLabel?: string | null;
  cluster?: VoiceCluster;
  archetypeTexturePhrase?: string | null;
  archetypeUseCase?: string | null;
}): { prompt: string; textureFlavor: DesignTextureFlavorStatus } {
  const { character, gender, age, slot } = input;
  const cluster = input.cluster ?? resolveVoiceCluster(character);
  const preferred = input.preferredSlot ?? inferVoiceSlot(character);
  const slotDiverged = !slotsEqual(preferred, slot);
  const textureCore = character.voiceTexture?.trim() || "";
  const personality = (character.personality || character.firstImpression || "")
    .trim()
    .replace(/\s+/g, "")
    .slice(0, 36);

  const ageGender = `${ageLabelNatural(age)}${genderLabelNatural(gender)}`;
  const pitch = `音高${PITCH_ZH[slot.pitchBand]}`;
  const texture = `质感${TEXTURE_ZH[slot.textureBand]}`;
  const energy = `气息${ENERGY_ZH[slot.energyBand]}`;
  const core = `${ageGender}，标准普通话，${pitch}，${texture}，${energy}`;

  const flavorParts: string[] = [];
  let textureFlavor: DesignTextureFlavorStatus = "none";

  if (textureCore) {
    const fullOk =
      !textureConflictsWithSlot(textureCore, slot.textureBand)
      && (!slotDiverged || slot.textureBand === preferred.textureBand);
    if (fullOk) {
      const clipped = compressTextureSnippet(textureCore, 28);
      if (clipped && !core.includes(clipped)) {
        flavorParts.push(clipped);
        textureFlavor = "card-full";
      }
    } else {
      const partial = extractCompatibleTextureSnippet(textureCore, slot.textureBand, 28);
      if (partial && !core.includes(partial)) {
        flavorParts.push(partial);
        textureFlavor = "card-partial";
      } else {
        textureFlavor = "card-dropped";
      }
    }
  }

  if (textureFlavor === "none" || textureFlavor === "card-dropped") {
    const archRaw = input.archetypeTexturePhrase?.trim() || "";
    if (archRaw) {
      const arch =
        extractCompatibleTextureSnippet(archRaw, slot.textureBand, 24)
        || (
          !textureConflictsWithSlot(archRaw, slot.textureBand)
            ? compressTextureSnippet(archRaw, 24)
            : ""
        );
      if (arch && !core.includes(arch) && !flavorParts.includes(arch)) {
        flavorParts.push(arch);
        if (textureFlavor === "none") textureFlavor = "archetype";
      }
    }
  }

  if (cluster === "lead") {
    flavorParts.push("吐字清楚有主心骨");
  } else if (slot.energyBand === "lively") {
    flavorParts.push("吐字轻快");
  } else if (slot.energyBand === "heavy") {
    flavorParts.push("吐字沉稳");
  } else {
    flavorParts.push("吐字清楚");
  }

  if (personality) {
    flavorParts.push(`气质${personality}`);
  } else if (cluster === "lead") {
    flavorParts.push("气质克制坚定");
  }

  // 先解析 useCase + 真实 mutex tail，再估 soft-target（禁止「。尾。」假尾误估）
  const resolvedUseCase = resolveDesignUseCase(character, cluster, gender);
  const archUseCase = input.archetypeUseCase?.trim().slice(0, 24) || "";
  const useCase =
    (!hasRoleSignal(character) && archUseCase)
      ? archUseCase
      : resolvedUseCase;

  const mutexPrimary = input.softCollision && input.neighborSlotLabel
    ? `与「${input.neighborSlotLabel}」明显区分`
    : "";
  const mutexSecondary = cluster === "lead" || cluster === "cast"
    ? "避免播音腔、空壳标准声与死气平板播读"
    : "避免播音腔与无特征标准声";
  const tailParts: string[] = [];
  if (mutexPrimary) tailParts.push(mutexPrimary);
  tailParts.push(mutexSecondary);
  let tail = tailParts.join("；");

  // 软目标：补声线习惯；估长与最终 `${body}。${tail}。` 同构
  const habits = speechHabitCandidates(slot, cluster);
  const estimatePromptLen = (midParts: string[]): number => {
    const mid = midParts.filter(Boolean).join("，");
    const bodyEst = mid ? `${core}，${mid}，适合${useCase}` : `${core}，适合${useCase}`;
    return `${bodyEst}。${tail}。`.length;
  };
  for (const habit of habits) {
    if (flavorParts.includes(habit)) continue;
    const trialParts = [...flavorParts, habit];
    const trialLen = estimatePromptLen(trialParts);
    if (trialLen > DESIGN_PROMPT_TARGET_MAX && flavorParts.length > 0) {
      // 已有内容且会超软顶则停；仍低于 MIN 时允许冲到 MAX
      const currentApprox = estimatePromptLen(flavorParts);
      if (currentApprox >= DESIGN_PROMPT_TARGET_MIN) break;
    }
    if (trialLen > DESIGN_PROMPT_MAX) break;
    flavorParts.push(habit);
  }

  const bodyMid = flavorParts.filter(Boolean).join("，");
  let body = bodyMid
    ? `${core}，${bodyMid}，适合${useCase}`
    : `${core}，适合${useCase}`;

  let prompt = `${body}。${tail}。`;
  if (prompt.length <= DESIGN_PROMPT_MAX) {
    // 仍短于软目标时再尝试塞剩余 habits（在 hard max 内）
    if (prompt.length < DESIGN_PROMPT_TARGET_MIN) {
      for (const habit of habits) {
        if (flavorParts.includes(habit)) continue;
        const nextMid = [...flavorParts, habit].join("，");
        const nextBody = `${core}，${nextMid}，适合${useCase}`;
        const next = `${nextBody}。${tail}。`;
        if (next.length > DESIGN_PROMPT_MAX) break;
        if (next.length > DESIGN_PROMPT_TARGET_MAX && prompt.length >= DESIGN_PROMPT_TARGET_MIN) break;
        flavorParts.push(habit);
        body = nextBody;
        prompt = next;
        if (prompt.length >= DESIGN_PROMPT_TARGET_MIN) break;
      }
    }
    return { prompt, textureFlavor };
  }

  const dropSteps: Array<() => void> = [
    () => {
      // 先丢习惯短语（非吐字/气质/声线）
      const coreFlavors = flavorParts.filter(
        (p) =>
          p.startsWith("吐字")
          || p.startsWith("气质")
          || p.includes("主心骨")
          || habits.indexOf(p) < 0,
      );
      // 实际：丢掉 speech habits
      const withoutHabits = flavorParts.filter((p) => !habits.includes(p));
      const mid = withoutHabits.join("，");
      body = mid ? `${core}，${mid}，适合${useCase}` : `${core}，适合${useCase}`;
      void coreFlavors;
    },
    () => {
      const withoutVibe = flavorParts
        .filter((p) => !p.startsWith("气质") && !habits.includes(p));
      const mid = withoutVibe.join("，");
      body = mid ? `${core}，${mid}，适合${useCase}` : `${core}，适合${useCase}`;
    },
    () => {
      const keep = flavorParts.filter(
        (p) => p.startsWith("吐字") || p.includes("主心骨") || (!p.startsWith("气质") && !habits.includes(p) && p.length <= 28),
      );
      // 保吐字 + 卡面/arch 声线片段
      const mid = keep.join("，") || "吐字清楚";
      body = `${core}，${mid}，适合${useCase}`;
    },
    () => {
      const keep = flavorParts.filter((p) => p.startsWith("吐字") || p.includes("主心骨"));
      const mid = keep.join("，") || "吐字清楚";
      body = `${core}，${mid}，适合${useCase}`;
    },
    () => {
      body = `${core}，适合${shortenUseCase(useCase)}`;
    },
    () => {
      body = core;
    },
    () => {
      tail = mutexPrimary || mutexSecondary;
    },
  ];

  for (const step of dropSteps) {
    step();
    prompt = body.endsWith("。") ? `${body}${tail}。` : `${body}。${tail}。`;
    if (prompt.length <= DESIGN_PROMPT_MAX) {
      return { prompt, textureFlavor };
    }
  }

  const hardTail = mutexPrimary ? `${mutexPrimary}。` : `${mutexSecondary}。`;
  const hard = `${core}。${hardTail}`;
  if (hard.length <= DESIGN_PROMPT_MAX) {
    return { prompt: hard, textureFlavor };
  }
  const coreOnly = `${core}。`;
  if (coreOnly.length <= DESIGN_PROMPT_MAX) {
    return { prompt: coreOnly, textureFlavor };
  }
  return { prompt: coreOnly.slice(0, DESIGN_PROMPT_MAX), textureFlavor };
}

function ageLabelNatural(age: VoiceAgeBucket): string {
  if (age === "youth") return "青年";
  if (age === "elder") return "年长";
  return "青壮年";
}

function genderLabelNatural(gender: VoiceGenderBucket): string {
  if (gender === "female") return "女性";
  if (gender === "male") return "男性";
  return "中性";
}

function compressTextureSnippet(raw: string, max: number): string {
  const cleaned = raw.replace(/[【】\[\]\n]/g, " ").replace(/\s+/g, "").trim();
  if (!cleaned) return "";
  return cleaned.slice(0, max);
}

function shortenUseCase(useCase: string): string {
  if (useCase.length <= 8) return useCase;
  return useCase.slice(0, 8);
}

function resolveDesignUseCase(
  character: VoicePlannerCharacterInput,
  cluster: VoiceCluster,
  gender: VoiceGenderBucket = "unknown",
): string {
  const role = `${character.role || ""} ${character.castRole || ""} ${character.storyFunction || ""}`;
  if (/反派|antagonist|BOSS|boss|对手/i.test(role)) return "权谋反派对白";
  if (/女主|heroine/i.test(role)) return "女主情感对白";
  if (/love_interest|红颜|情郎|爱人/i.test(role)) return "情感对白";
  if (/男主/i.test(role)) return "男主对白";
  if (cluster === "lead" || /主角|protagonist/i.test(role)) {
    if (gender === "female") return "女主对白";
    if (gender === "male") return "男主对白";
    return "主角对白";
  }
  if (cluster === "cast") return "主角团对白";
  if (cluster === "narrator") return "旁白叙述";
  return "网文角色对白";
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

/**
 * 路人 preset 簇：按性别固定「泛用」声，与主角团 design 分离（分配维）。
 * 旁白：女→茉莉、男→白桦、未知→茉莉（与常见默认旁白一致）。
 */
function extraPresetPool(gender: VoiceGenderBucket): MimoTtsPresetVoice[] {
  if (gender === "female") return ["冰糖", "茉莉"];
  if (gender === "male") return ["苏打", "白桦"];
  return ["苏打", "冰糖"];
}

function narratorPresetPool(gender: VoiceGenderBucket): MimoTtsPresetVoice[] {
  if (gender === "male") return ["白桦", "苏打"];
  return ["茉莉", "冰糖"];
}

function presetPool(
  gender: VoiceGenderBucket,
  age: VoiceAgeBucket,
  cluster?: VoiceCluster,
): MimoTtsPresetVoice[] {
  if (cluster === "narrator") return narratorPresetPool(gender);
  if (cluster === "extra") return extraPresetPool(gender);
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

/**
 * onlyMissing：已绑定 design 占用槽位，避免新角撞上旧 design prompt 维。
 * 结构化标签可精确 seed；无标签时回退卡字段推断并标 seed:inferred。
 */
function seedBoundDesignSlot(
  occupiedSlots: Set<string>,
  occupiedSlotByKey: Map<string, VoiceSlot>,
  character: VoicePlannerCharacterInput,
): { seeded: boolean; inferred: boolean } {
  const mode = character.ttsMode?.trim() || "preset";
  if (mode !== "design" || !character.ttsDesignPrompt?.trim()) {
    return { seeded: false, inferred: false };
  }
  const gender = inferGenderBucket(character);
  const parsed = parseSlotFromDesignPrompt(character.ttsDesignPrompt);
  const inferred = !parsed;
  const slot = parsed ?? inferVoiceSlot(character);
  const key = slotKey(gender, slot);
  occupiedSlots.add(key);
  if (!occupiedSlotByKey.has(key)) {
    occupiedSlotByKey.set(key, slot);
  }
  return { seeded: true, inferred };
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
 * - prefer_design：lead/cast → design + 槽位拉开；extra/narrator → 路人/旁白 preset 簇
 * - auto（smart_fill）：lead/cast → design；extra/narrator → preset；未知簇 importance≥70 且有 texture → design
 * - preset_only：仅 preset 负载均衡（旁白/路人用分簇池）
 * - reservedPresets：旁白等占用的预置，角色 preset 池剔除；池空则 lead/cast 强制 design
 * - clone+非空 ref 永不改写；无 ref 的 half-clone 可规划为 preset/design
 * - 覆盖语义由调用方 onlyMissing + apply.overwrite 处理（本函数不接收 overwrite）
 */
export function planCharacterVoices(input: {
  characters: VoicePlannerCharacterInput[];
  strategy?: AudiobookVoicePlanStrategy;
  onlyMissing?: boolean;
  characterIds?: string[];
  maxImportantPerPreset?: number;
  /** 旁白等占用的预置音色，角色池剔除 */
  reservedPresets?: string[];
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
  const reservedSet = new Set(
    (input.reservedPresets ?? [])
      .map((v) => v.trim())
      .filter((v): v is MimoTtsPresetVoice => Boolean(v) && isMimoTtsPresetVoice(v)),
  );

  const skipped: Array<{ characterId: string; characterName: string; reason: string }> = [];
  const candidates: Array<
    VoicePlannerCharacterInput & {
      genderBucket: VoiceGenderBucket;
      ageBucket: VoiceAgeBucket;
      importance: number;
      configured: boolean;
      preferredSlot: VoiceSlot;
      cluster: VoiceCluster;
    }
  > = [];
  const usage = new Map<string, number>();
  const importantUsage = new Map<string, number>();
  const occupiedSlots = new Set<string>();
  const occupiedSlotByKey = new Map<string, VoiceSlot>();
  /** lead 同性别已用 energy，规划时主动散开 */
  const leadEnergyByGender = new Map<VoiceGenderBucket, Set<VoiceEnergyBand>>();

  // 旁白预置预 seed usage，降低角色再抢同声
  for (const voice of reservedSet) {
    usage.set(voice, (usage.get(voice) ?? 0) + 1);
  }

  for (const character of input.characters) {
    if (allowIds && !allowIds.has(character.characterId)) {
      continue;
    }

    const mode = character.ttsMode?.trim() || "preset";
    // 仅「clone + 非空 ref」永久 skip；无 ref 的 half-clone 可规划为 preset/design（apply 可覆盖）
    if (mode === "clone" && character.ttsRefAudioPath?.trim()) {
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
      const seed = seedBoundDesignSlot(occupiedSlots, occupiedSlotByKey, character);
      skipped.push({
        characterId: character.characterId,
        characterName: character.characterName,
        reason: seed.inferred
          ? "已绑定音色（onlyMissing=true） seed:inferred。"
          : "已绑定音色（onlyMissing=true）。",
      });
      continue;
    }

    const cluster = resolveVoiceCluster(character);
    candidates.push({
      ...character,
      genderBucket: inferGenderBucket(character),
      ageBucket: inferAgeBucket(character),
      importance: scoreImportance(character),
      configured,
      preferredSlot: inferVoiceSlot(character),
      cluster,
    });
  }

  candidates.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return a.characterName.localeCompare(b.characterName, "zh");
  });

  const items: AudiobookVoicePlanItem[] = [];

  for (const character of candidates) {
    const poolAll = presetPool(character.genderBucket, character.ageBucket, character.cluster);
    const pool = poolAll.filter((v) => !reservedSet.has(v));
    let ttsMode: AudiobookTtsMode = "preset";
    let ttsVoice: string | null = null;
    let ttsDesignPrompt: string | null = null;
    let reason = "";
    let designSlot: VoiceSlot | null = null;
    let softCollision = false;

    const hasTexture = Boolean(character.voiceTexture?.trim());
    const isLeadOrCast = character.cluster === "lead" || character.cluster === "cast";
    // smart_fill (auto)：主配角默认 design，不再依赖 texture 门槛
    const smartFillCore = strategy === "auto" && isLeadOrCast;
    // auto 未知簇 / 非 lead-cast 高重要 + texture → design
    const autoDesignByTexture =
      strategy === "auto" && !isLeadOrCast && character.importance >= 70 && hasTexture;
    // prefer_design：仅主角/主角团 design；路人/旁白强制 preset 簇
    const preferDesignCore =
      strategy === "prefer_design" && isLeadOrCast;

    if (preferDesignCore || smartFillCore || autoDesignByTexture) {
      ttsMode = "design";
      if (preferDesignCore) {
        reason = character.cluster === "lead"
          ? "策略 prefer_design：主角簇 design，忌死气槽位。"
          : "策略 prefer_design：主角团 design，槽位拉开。";
      } else if (smartFillCore) {
        reason = character.cluster === "lead"
          ? "策略 smart_fill(auto)：主角簇 design（分配维，非听感证明）。"
          : "策略 smart_fill(auto)：主角团 design（分配维，非听感证明）。";
      } else {
        reason = "auto：高重要性且有 voiceTexture，用 design 拉开 prompt 维（非听感证明）。";
      }
    } else if (strategy === "prefer_design" && !isLeadOrCast) {
      ttsMode = "preset";
      reason = character.cluster === "narrator"
        ? "策略 prefer_design：旁白簇走预置，与角色 design 隔离。"
        : "策略 prefer_design：路人簇走预置，与主角/主角团 design 隔离。";
    }

    if (ttsMode === "preset") {
      if (pool.length === 0) {
        // 预置池被 reserved 抽空：主配角强制 design；路人用全池兜底
        if (isLeadOrCast || strategy !== "preset_only") {
          ttsMode = "design";
          reason = reservedSet.size > 0
            ? "reservedPresets 抽空可用预置池，升 design 避免与旁白撞车。"
            : "预置池为空，升 design。";
        } else {
          const fallback = pickLeastUsedPreset(poolAll.length ? poolAll : [...UNKNOWN_POOL], usage);
          ttsVoice = fallback;
          usage.set(fallback, (usage.get(fallback) ?? 0) + 1);
          reason = `预置池被 reserved 抽空，回退「${fallback}」。`;
        }
      } else {
        const voice = pickLeastUsedPreset(pool, usage);
        const importantCount = importantUsage.get(voice) ?? 0;
        const isImportant = character.importance >= 55;

        if (
          strategy !== "preset_only"
          && strategy !== "prefer_design"
          && isImportant
          && importantCount >= maxImportantPerPreset
        ) {
          ttsMode = "design";
          reason = `预置「${voice}」重要角色位已满，升 design 避免同 preset 复用（分配维，非听感证明）。`;
        } else {
          ttsMode = "preset";
          ttsVoice = voice;
          usage.set(voice, (usage.get(voice) ?? 0) + 1);
          if (isImportant) {
            importantUsage.set(voice, importantCount + 1);
          }
          if (!reason) {
            reason = `按${character.cluster}/${character.genderBucket}/${character.ageBucket}分配预置「${voice}」，负载均衡。`;
          } else {
            reason = `${reason} 预置「${voice}」。`.trim();
          }
          if (reservedSet.size > 0) {
            reason = `${reason} reserved:filtered。`.trim();
          }
        }
      }
    }

    if (ttsMode === "design") {
      const minSeparation = isLeadOrCast ? 2 : 0;
      const preserveTexture = hasLockableVoiceTexture(character);
      let preferredSlot = character.preferredSlot;

      // lead 同性别能量带主动散开，避免全员 heavy
      if (character.cluster === "lead") {
        const usedEnergies = leadEnergyByGender.get(character.genderBucket) ?? new Set<VoiceEnergyBand>();
        if (usedEnergies.has(preferredSlot.energyBand)) {
          for (const energyBand of ENERGY_ORDER) {
            if (!usedEnergies.has(energyBand)) {
              preferredSlot = { ...preferredSlot, energyBand };
              break;
            }
          }
        }
      }

      const allocated = allocateVoiceSlot({
        gender: character.genderBucket,
        preferred: preferredSlot,
        occupied: occupiedSlots,
        occupiedSlotByKey,
        minSeparation,
        preserveTexture,
      });
      designSlot = allocated.slot;
      softCollision = allocated.softCollision;

      const neighborSlot = softCollision
        ? occupiedSlotByKey.get(allocated.key) ?? null
        : null;
      const neighbor = neighborSlot ? neighborLabel(neighborSlot) : null;
      const slotDiverged = !slotsEqual(character.preferredSlot, allocated.slot);

      const archetype = pickDesignPromptArchetype({
        character,
        gender: character.genderBucket,
        age: character.ageBucket,
        cluster: character.cluster,
      });
      const built = buildDesignPromptDetailed({
        character,
        gender: character.genderBucket,
        age: character.ageBucket,
        slot: allocated.slot,
        preferredSlot: character.preferredSlot,
        softCollision,
        neighborSlotLabel: softCollision ? neighbor : null,
        cluster: character.cluster,
        archetypeTexturePhrase: archetype?.texturePhrase ?? null,
        archetypeUseCase: archetype?.useCase ?? null,
      });
      ttsDesignPrompt = built.prompt;
      if (archetype) {
        reason = `${reason} archetype:${archetype.id}`.trim();
      }
      if (preserveTexture) {
        reason = `${reason} texture:locked`.trim();
      }
      if (built.textureFlavor === "card-partial") {
        reason = `${reason} texture:card-partial`.trim();
      } else if (built.textureFlavor === "card-dropped") {
        reason = `${reason} texture:card-dropped`.trim();
      } else if (built.textureFlavor === "card-full") {
        reason = `${reason} texture:card-kept`.trim();
      }

      markSlotOccupied(occupiedSlots, occupiedSlotByKey, allocated.key, allocated.slot);
      if (character.cluster === "lead") {
        const set = leadEnergyByGender.get(character.genderBucket) ?? new Set<VoiceEnergyBand>();
        set.add(allocated.slot.energyBand);
        leadEnergyByGender.set(character.genderBucket, set);
      }

      if (softCollision) {
        reason = `${reason} collision:soft`.trim();
      } else if (slotDiverged) {
        reason = `${reason} slot:override ${allocated.key}。`.trim();
      } else if (!reason.includes("槽") && (strategy === "prefer_design" || strategy === "auto" || minSeparation > 0)) {
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
      cluster: character.cluster,
      currentBinding: {
        ttsMode: character.ttsMode ?? null,
        ttsVoice: character.ttsVoice ?? null,
        ttsDesignPrompt: character.ttsDesignPrompt ?? null,
      },
    });
  }

  return { items, skipped };
}
