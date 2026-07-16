/**
 * Design prompt 弱卡种子表（身份文案补全，不盖 slot 三元）。
 * 纯数据 + 稳定 match；禁止明星名。
 */

import type { VoiceAgeBucket, VoiceCluster, VoiceGenderBucket, VoicePlannerCharacterInput } from "./audiobookVoicePlanner";

export interface DesignPromptArchetype {
  id: string;
  gender: VoiceGenderBucket | "any";
  age: VoiceAgeBucket | "any";
  cluster?: VoiceCluster | "any";
  roleHints: string[];
  texturePhrase: string;
  useCase?: string;
}

/** ~24 条手写中文种子；表序稳定，同分取先出现项 */
export const DESIGN_PROMPT_ARCHETYPES: DesignPromptArchetype[] = [
  {
    id: "lead-male-youth",
    gender: "male",
    age: "youth",
    cluster: "lead",
    roleHints: ["主角", "男主", "protagonist"],
    texturePhrase: "清亮偏薄略干",
    useCase: "男主对白",
  },
  {
    id: "lead-male-adult",
    gender: "male",
    age: "adult",
    cluster: "lead",
    roleHints: ["主角", "男主", "protagonist"],
    texturePhrase: "中性干净带一点金属感",
    useCase: "男主对白",
  },
  {
    id: "lead-female-youth",
    gender: "female",
    age: "youth",
    cluster: "lead",
    roleHints: ["女主", "女主角", "heroine"],
    texturePhrase: "清亮软而不糯",
    useCase: "女主情感对白",
  },
  {
    id: "lead-female-adult",
    gender: "female",
    age: "adult",
    cluster: "lead",
    roleHints: ["女主", "女主角", "heroine"],
    texturePhrase: "清亮稳、不甜腻",
    useCase: "女主情感对白",
  },
  {
    id: "cast-antagonist-male",
    gender: "male",
    age: "adult",
    cluster: "cast",
    roleHints: ["反派", "antagonist", "boss", "对手"],
    texturePhrase: "偏低略沙、共鸣靠后",
    useCase: "权谋反派对白",
  },
  {
    id: "cast-antagonist-female",
    gender: "female",
    age: "adult",
    cluster: "cast",
    roleHints: ["反派", "antagonist", "女反"],
    texturePhrase: "冷亮细而硬",
    useCase: "权谋反派对白",
  },
  {
    id: "cast-mentor-elder-male",
    gender: "male",
    age: "elder",
    cluster: "cast",
    roleHints: ["师父", "导师", "mentor", "长辈"],
    texturePhrase: "厚实沉、不虚",
    useCase: "长辈导师对白",
  },
  {
    id: "cast-mentor-elder-female",
    gender: "female",
    age: "elder",
    cluster: "cast",
    roleHints: ["师父", "导师", "mentor", "长辈", "婆婆"],
    texturePhrase: "沉稳温和不飘",
    useCase: "长辈导师对白",
  },
  {
    id: "cast-ally-male-youth",
    gender: "male",
    age: "youth",
    cluster: "cast",
    roleHints: ["伙伴", "兄弟", "ally", "好友"],
    texturePhrase: "明亮利落",
    useCase: "主角团对白",
  },
  {
    id: "cast-ally-female-youth",
    gender: "female",
    age: "youth",
    cluster: "cast",
    roleHints: ["闺蜜", "伙伴", "ally", "好友"],
    texturePhrase: "轻快清脆",
    useCase: "主角团对白",
  },
  {
    id: "cast-ally-male-adult",
    gender: "male",
    age: "adult",
    cluster: "cast",
    roleHints: ["伙伴", "兄弟", "ally", "好友", "配角"],
    texturePhrase: "中性干净略稳",
    useCase: "主角团对白",
  },
  {
    id: "cast-ally-female-adult",
    gender: "female",
    age: "adult",
    cluster: "cast",
    roleHints: ["闺蜜", "伙伴", "ally", "好友", "配角"],
    texturePhrase: "清亮稳、不甜腻",
    useCase: "主角团对白",
  },
  {
    id: "cast-generic-male-adult",
    gender: "male",
    age: "adult",
    cluster: "cast",
    roleHints: [],
    texturePhrase: "中性干净",
    useCase: "主角团对白",
  },
  {
    id: "cast-generic-female-adult",
    gender: "female",
    age: "adult",
    cluster: "cast",
    roleHints: [],
    texturePhrase: "中性干净",
    useCase: "主角团对白",
  },
  {
    id: "cast-love-female",
    gender: "female",
    age: "adult",
    cluster: "cast",
    roleHints: ["爱人", "love_interest", "红颜"],
    texturePhrase: "柔而不虚",
    useCase: "情感对白",
  },
  {
    id: "cast-love-male",
    gender: "male",
    age: "adult",
    cluster: "cast",
    roleHints: ["爱人", "love_interest", "情郎"],
    texturePhrase: "温润中性",
    useCase: "情感对白",
  },
  {
    id: "cast-strategist-male",
    gender: "male",
    age: "adult",
    cluster: "cast",
    roleHints: ["军师", "谋士", "智囊"],
    texturePhrase: "平稳克制略薄",
    useCase: "权谋对白",
  },
  {
    id: "cast-strategist-female",
    gender: "female",
    age: "adult",
    cluster: "cast",
    roleHints: ["军师", "谋士", "智囊"],
    texturePhrase: "清冷平稳",
    useCase: "权谋对白",
  },
  {
    id: "cast-child-youth-unknown",
    gender: "any",
    age: "youth",
    cluster: "cast",
    roleHints: ["孩", "童", "少年", "少女"],
    texturePhrase: "偏细亮、稚而不尖",
    useCase: "少年对白",
  },
  {
    id: "extra-male-adult",
    gender: "male",
    age: "adult",
    cluster: "extra",
    roleHints: ["路人", "士兵", "侍卫", "店小二"],
    texturePhrase: "中性干净普通",
    useCase: "路人对白",
  },
  {
    id: "extra-female-adult",
    gender: "female",
    age: "adult",
    cluster: "extra",
    roleHints: ["路人", "丫鬟", "侍女", "店小二"],
    texturePhrase: "中性干净普通",
    useCase: "路人对白",
  },
  {
    id: "cast-pressure-male",
    gender: "male",
    age: "adult",
    cluster: "cast",
    roleHints: ["压力", "pressure", "上司", "权贵"],
    texturePhrase: "沉稳有分量",
    useCase: "压迫感对白",
  },
  {
    id: "cast-foil-female",
    gender: "female",
    age: "adult",
    cluster: "cast",
    roleHints: ["foil", "对照", "情敌"],
    texturePhrase: "亮而锋利",
    useCase: "对照角色对白",
  },
  {
    id: "cast-catalyst-any",
    gender: "any",
    age: "adult",
    cluster: "cast",
    roleHints: ["catalyst", "触媒", "推手"],
    texturePhrase: "活泼有弹性",
    useCase: "触媒角色对白",
  },
  {
    id: "fallback-male-adult",
    gender: "male",
    age: "adult",
    cluster: "any",
    roleHints: [],
    texturePhrase: "中性干净",
    useCase: "网文角色对白",
  },
  {
    id: "fallback-female-adult",
    gender: "female",
    age: "adult",
    cluster: "any",
    roleHints: [],
    texturePhrase: "中性干净",
    useCase: "网文角色对白",
  },
  {
    id: "fallback-unknown-adult",
    gender: "unknown",
    age: "adult",
    cluster: "any",
    roleHints: [],
    texturePhrase: "中性干净略柔",
    useCase: "网文角色对白",
  },
  {
    id: "fallback-youth-any",
    gender: "any",
    age: "youth",
    cluster: "any",
    roleHints: [],
    texturePhrase: "偏年轻清亮",
    useCase: "青年角色对白",
  },
];

/** 角色/功能信号；不含 characterName，避免专名误抬分 */
function roleBlob(character: VoicePlannerCharacterInput): string {
  return [
    character.role,
    character.castRole,
    character.storyFunction,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** 强立场种子：无 roleHints 命中时降权，避免 ally 落到反派 */
const STRONG_STANCE_ARCHETYPE_IDS = new Set([
  "cast-antagonist-male",
  "cast-antagonist-female",
  "cast-pressure-male",
  "cast-foil-female",
  "cast-catalyst-any",
  "cast-strategist-male",
  "cast-strategist-female",
  "cast-mentor-elder-male",
  "cast-mentor-elder-female",
  "cast-love-female",
  "cast-love-male",
]);

/**
 * 弱卡：无 voiceTexture，且气质描述不足。
 * 有 texture 或 personality/firstImpression 字数 ≥4 视为已有卡面声线/气质，不补 archetype。
 */
function isWeakCard(character: VoicePlannerCharacterInput): boolean {
  const texture = character.voiceTexture?.trim() || "";
  if (texture) return false;
  const personality = (character.personality || character.firstImpression || "").trim();
  return personality.length < 4;
}

export function scoreDesignPromptArchetype(
  arch: DesignPromptArchetype,
  input: {
    gender: VoiceGenderBucket;
    age: VoiceAgeBucket;
    cluster: VoiceCluster;
    character: VoicePlannerCharacterInput;
  },
): number {
  let score = 0;
  if (arch.gender === input.gender) score += 4;
  else if (arch.gender === "any") score += 1;
  else return -1;

  if (arch.age === input.age) score += 3;
  else if (arch.age === "any") score += 1;
  else score -= 1;

  if (!arch.cluster || arch.cluster === "any") {
    score += 0;
  } else if (arch.cluster === input.cluster) {
    score += 3;
  } else {
    score -= 1;
  }

  const blob = roleBlob(input.character);
  let hintHit = false;
  for (const hint of arch.roleHints) {
    if (hint && blob.includes(hint.toLowerCase())) {
      score += 5;
      hintHit = true;
      break;
    }
  }

  // 无任何 roleHints 的通用种子：弱补分，避免被强立场表序抢先
  if (arch.roleHints.length === 0 && arch.cluster === input.cluster) {
    score += 2;
  }

  // 强立场种子必须有 roleHints 命中；否则大幅降权
  if (STRONG_STANCE_ARCHETYPE_IDS.has(arch.id) && !hintHit) {
    score -= 8;
  }

  return score;
}

/**
 * 仅弱卡返回种子；有 voiceTexture 或 personality 足够时返回 null。
 * 同分取表序靠前项，保证稳定。
 */
export function pickDesignPromptArchetype(input: {
  character: VoicePlannerCharacterInput;
  gender: VoiceGenderBucket;
  age: VoiceAgeBucket;
  cluster: VoiceCluster;
}): DesignPromptArchetype | null {
  if (!isWeakCard(input.character)) {
    return null;
  }

  let best: DesignPromptArchetype | null = null;
  let bestScore = -1;
  for (const arch of DESIGN_PROMPT_ARCHETYPES) {
    const score = scoreDesignPromptArchetype(arch, input);
    if (score > bestScore) {
      bestScore = score;
      best = arch;
    }
  }
  if (!best || bestScore < 0) {
    return null;
  }
  return best;
}
