import {
  type AudiobookTtsMode,
  type AudiobookVoicePlanItem,
  type AudiobookVoicePlanStrategy,
  type MimoTtsPresetVoice,
} from "@ai-novel/shared/types/audiobook";

export type VoiceGenderBucket = "male" | "female" | "unknown";
export type VoiceAgeBucket = "youth" | "adult" | "elder" | "unknown";

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
const ROUGH_HINT = /沙哑|低沉|沉稳|冷硬|阴|狠|粗|哑|沧桑|威严|肃|冷/i;
const BRIGHT_HINT = /清亮|甜|脆|活泼|软|温柔|明快|灵动|俏|软糯|轻快/i;

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

function presetPool(gender: VoiceGenderBucket, age: VoiceAgeBucket): MimoTtsPresetVoice[] {
  if (gender === "female") {
    return age === "youth" ? [...FEMALE_YOUTH] : [...FEMALE_ADULT];
  }
  if (gender === "male") {
    return age === "youth" ? [...MALE_YOUTH] : [...MALE_ADULT];
  }
  return [...UNKNOWN_POOL];
}

function buildDesignPrompt(input: VoicePlannerCharacterInput, gender: VoiceGenderBucket, age: VoiceAgeBucket): string {
  if (input.voiceTexture?.trim()) {
    const base = input.voiceTexture.trim();
    if (base.length >= 12) {
      return base.slice(0, 480);
    }
  }

  const genderLabel =
    gender === "female" ? "女性" : gender === "male" ? "男性" : "中性偏柔";
  const ageLabel =
    age === "youth" ? "偏年轻" : age === "elder" ? "偏年长" : "青壮年";
  const textureBlob = [
    input.voiceTexture,
    input.personality,
    input.firstImpression,
    input.appearance,
  ]
    .filter(Boolean)
    .join("；");

  let tone = "吐字清楚，语速中等，情绪克制，适合小说对白。";
  if (ROUGH_HINT.test(textureBlob)) {
    tone = "声线偏低略沙哑，气息沉稳，语速偏慢，适合冷硬或威压对白。";
  } else if (BRIGHT_HINT.test(textureBlob)) {
    tone = "声线明亮清脆，语速略快，情绪活泼，适合轻松或软甜对白。";
  }

  const roleBit = (input.role || input.castRole || "配角").toString().slice(0, 32);
  const name = input.characterName.slice(0, 24);
  const personality = (input.personality || "").trim().slice(0, 80);
  const parts = [
    `${genderLabel}${ageLabel}角色「${name}」`,
    `叙事身份：${roleBit}`,
    personality ? `性格：${personality}` : null,
    tone,
    "中文普通话，不要夸张配音腔。",
  ].filter(Boolean);
  return parts.join("，").slice(0, 480);
}

function buildStyle(input: VoicePlannerCharacterInput): string {
  const texture = input.voiceTexture?.trim();
  if (texture) {
    return texture.slice(0, 200);
  }
  const personality = input.personality?.trim();
  if (personality) {
    return `符合角色气质：${personality.slice(0, 120)}。吐字清楚，语速中等。`.slice(0, 200);
  }
  return "符合角色身份，吐字清楚，语速中等，情绪自然。";
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
 * 纯函数：根据人物卡批量规划差异化音色。
 * - 重要角色优先拿差异化 preset；同 preset 重要角色过多则升 design
 * - 次要角色尽量填满 preset 池
 * - onlyMissing 跳过已绑定时，usage 会 seed 已绑定 preset，避免撞声
 * - 已配置 clone 参考音频的角色永不进入规划（需用户在角色卡改）
 */
export function planCharacterVoices(input: {
  characters: VoicePlannerCharacterInput[];
  strategy?: AudiobookVoicePlanStrategy;
  onlyMissing?: boolean;
  characterIds?: string[];
  maxImportantPerPreset?: number;
  overwrite?: boolean;
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
    }
  > = [];
  const usage = new Map<string, number>();
  const importantUsage = new Map<string, number>();

  for (const character of input.characters) {
    if (allowIds && !allowIds.has(character.characterId)) {
      continue;
    }

    const mode = character.ttsMode?.trim() || "preset";
    const cloneBound = mode === "clone" && Boolean(character.ttsRefAudioPath?.trim());
    // clone 参考音是用户资产：规划器永不改写（含 onlyMissing=false 的重新差异化）
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

    if (strategy === "prefer_design" || (strategy === "auto" && character.importance >= 70 && character.voiceTexture?.trim())) {
      // 高重要且有声线描述：优先 design 保证辨识度
      if (strategy === "prefer_design" || character.importance >= 80) {
        ttsMode = "design";
        ttsDesignPrompt = buildDesignPrompt(character, character.genderBucket, character.ageBucket);
        reason = strategy === "prefer_design"
          ? "策略 prefer_design：按人物卡生成 design 描述。"
          : "高重要性角色：用 design 保证声线辨识度。";
      }
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
        ttsDesignPrompt = buildDesignPrompt(character, character.genderBucket, character.ageBucket);
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

    if (ttsMode === "design" && !ttsDesignPrompt) {
      ttsDesignPrompt = buildDesignPrompt(character, character.genderBucket, character.ageBucket);
    }

    items.push({
      characterId: character.characterId,
      characterName: character.characterName,
      ttsMode,
      ttsVoice,
      ttsStyle: buildStyle(character),
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
