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

  // 主角忌默认「平稳克制」死气：无活泼线索时抬到 heavy（坚定主心骨，非听感证明）
  const cluster = resolveVoiceCluster(input);
  if (cluster === "lead" && energyBand === "even" && !LIVELY_HINT.test(blob)) {
    energyBand = "heavy";
  }

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
}): { slot: VoiceSlot; key: string; softCollision: boolean } {
  const minSep = Math.max(0, Math.min(3, input.minSeparation ?? 0));
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

  // 两轮：先满足 minSep，再降级为仅 key 不撞（避免池尽 soft 过早）
  for (const requireSep of minSep > 0 ? [minSep, 0] : [0]) {
    if (preferred.free && preferred.sep >= requireSep) {
      return { slot: preferred.slot, key: preferred.key, softCollision: false };
    }

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

  // 池尽 soft：固定 preferred.key，供邻居 map 解析
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
 * Voice Design 身份文案（自然语言一段 + 可解析三元锚点）。
 * - 强制含：音高{PITCH_ZH} / 质感{TEXTURE_ZH} / 气息{ENERGY_ZH}（onlyMissing seed）
 * - 无【标签】主结构；默认不写角色专名
 * - softCollision 互斥首句 hard-keep；超长按优先级截断，硬顶 DESIGN_PROMPT_MAX
 * - lead 忌死气平板；slot 扰动后禁止对立 texture 整句粘贴
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
  if (
    textureCore
    && !slotDiverged
    && !textureConflictsWithSlot(textureCore, slot.textureBand)
  ) {
    const clipped = compressTextureSnippet(textureCore, 28);
    if (clipped && !core.includes(clipped)) {
      flavorParts.push(clipped);
    }
  } else if (
    !textureCore
    && input.archetypeTexturePhrase?.trim()
  ) {
    const arch = compressTextureSnippet(input.archetypeTexturePhrase.trim(), 24);
    if (arch && !textureConflictsWithSlot(arch, slot.textureBand)) {
      flavorParts.push(arch);
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

  const useCase =
    (input.archetypeUseCase?.trim() && input.archetypeUseCase.trim().slice(0, 24))
    || resolveDesignUseCase(character, cluster);
  const bodyMid = flavorParts.filter(Boolean).join("，");
  let body = bodyMid
    ? `${core}，${bodyMid}，适合${useCase}`
    : `${core}，适合${useCase}`;

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

  let prompt = `${body}。${tail}。`;
  if (prompt.length <= DESIGN_PROMPT_MAX) {
    return prompt;
  }

  // 丢弃顺序：archetype/气质细节 → 次互斥缩短 → use case 缩短 → 仍超则硬截（保三元+ soft 首句）
  const dropSteps: Array<() => void> = [
    () => {
      // 去掉气质片段
      const withoutVibe = flavorParts.filter((p) => !p.startsWith("气质"));
      const mid = withoutVibe.join("，");
      body = mid ? `${core}，${mid}，适合${useCase}` : `${core}，适合${useCase}`;
    },
    () => {
      // 去掉额外 texture 风味，只留吐字
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
      return prompt;
    }
  }

  // 硬保：三元 core + soft 首句（若有）
  const hardTail = mutexPrimary ? `${mutexPrimary}。` : `${mutexSecondary}。`;
  const hard = `${core}。${hardTail}`;
  if (hard.length <= DESIGN_PROMPT_MAX) {
    return hard;
  }
  return hard.slice(0, DESIGN_PROMPT_MAX);
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
): string {
  const role = `${character.role || ""} ${character.castRole || ""}`;
  if (/反派|antagonist|BOSS|boss|对手/i.test(role)) return "权谋反派对白";
  if (/女主|heroine|love_interest/i.test(role)) return "女主情感对白";
  if (cluster === "lead" || /主角|protagonist|男主/i.test(role)) return "男主对白";
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
 * - auto（保守）：importance≥70 且有 voiceTexture → design；重要 preset 位满 → design；其余 preset
 * - preset_only：仅 preset 负载均衡（旁白/路人用分簇池）
 * - clone+非空 ref 永不改写；无 ref 的 half-clone 可规划为 preset/design
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
      cluster: VoiceCluster;
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
    const pool = presetPool(character.genderBucket, character.ageBucket, character.cluster);
    let ttsMode: AudiobookTtsMode = "preset";
    let ttsVoice: string | null = null;
    let ttsDesignPrompt: string | null = null;
    let reason = "";
    let designSlot: VoiceSlot | null = null;
    let softCollision = false;

    const hasTexture = Boolean(character.voiceTexture?.trim());
    const isLeadOrCast = character.cluster === "lead" || character.cluster === "cast";
    // auto 保守：importance≥70 且有 texture → design（删除内层 ≥80 死区）
    const autoDesignByTexture = strategy === "auto" && character.importance >= 70 && hasTexture;
    // prefer_design：仅主角/主角团 design；路人/旁白强制 preset 簇（分配维，非听感证明）
    const preferDesignCore =
      strategy === "prefer_design" && isLeadOrCast;

    if (preferDesignCore || autoDesignByTexture) {
      ttsMode = "design";
      if (preferDesignCore) {
        reason = character.cluster === "lead"
          ? "策略 prefer_design：主角簇 design，忌死气槽位。"
          : "策略 prefer_design：主角团 design，槽位拉开。";
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
      }
    }

    if (ttsMode === "design") {
      const minSeparation = isLeadOrCast ? 2 : 0;
      const allocated = allocateVoiceSlot({
        gender: character.genderBucket,
        preferred: character.preferredSlot,
        occupied: occupiedSlots,
        occupiedSlotByKey,
        minSeparation,
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
        cluster: character.cluster,
      });

      markSlotOccupied(occupiedSlots, occupiedSlotByKey, allocated.key, allocated.slot);

      if (softCollision) {
        reason = `${reason} collision:soft`.trim();
      } else if (slotDiverged) {
        reason = `${reason} slot:override ${allocated.key}。`.trim();
      } else if (!reason.includes("槽") && (strategy === "prefer_design" || minSeparation > 0)) {
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
