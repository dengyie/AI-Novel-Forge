/**
 * Design prompt 声学癖好 / 冲突表（阶段 2 听感规约）。
 * - 癖好必须可映射到发声维（共鸣/气声/语速/句尾），禁止剧情/导演空话
 * - 与 slot 三元冲突的短语不得进入 identity
 * - 禁止为凑字数堆同义灌水
 * 本文件禁止 import audiobookVoicePlanner（避免循环依赖）。
 */

export type QuirkTextureBand = "bright" | "neutral" | "dark_raspy" | "airy";
export type QuirkEnergyBand = "lively" | "even" | "heavy";
export type QuirkCluster = "lead" | "cast" | "extra" | "narrator";

export type QuirkSlot = {
  pitchBand: "high" | "mid" | "low";
  textureBand: QuirkTextureBand;
  energyBand: QuirkEnergyBand;
};

export type SpeechQuirkSeed = {
  id: string;
  /** 短声学指令，≤18 字 */
  phrase: string;
  textureBands?: QuirkTextureBand[];
  energyBands?: QuirkEnergyBand[];
  clusters?: QuirkCluster[];
};

/**
 * 候选癖好表（稳定序）。同 slot 多候选时用 characterId hash 打散。
 * 禁止：明星名、场景动作、产品腔、「吐字清楚」类 body 已覆盖灌水词。
 */
export const SPEECH_QUIRK_SEEDS: SpeechQuirkSeed[] = [
  {
    id: "bright-bite",
    phrase: "咬字偏亮但不刺耳",
    textureBands: ["bright"],
  },
  {
    id: "dark-rear-res",
    phrase: "共鸣略靠后、不压喉",
    textureBands: ["dark_raspy"],
  },
  {
    id: "airy-hold",
    phrase: "气声收住、不虚飘",
    textureBands: ["airy"],
  },
  {
    id: "neutral-clean",
    phrase: "声线干净、无明显口音",
    textureBands: ["neutral"],
  },
  {
    id: "heavy-pace",
    phrase: "日常语速偏稳，激动也不尖",
    energyBands: ["heavy"],
  },
  {
    id: "lively-pace",
    phrase: "语速可略快，句尾轻扬",
    energyBands: ["lively"],
  },
  {
    id: "even-pace",
    phrase: "语速中等，收尾干净",
    energyBands: ["even"],
  },
  {
    id: "lead-center",
    phrase: "对白有角色重心，不演旁白",
    clusters: ["lead"],
  },
  {
    id: "cast-distinct",
    phrase: "与主角声线可辨，不抢戏",
    clusters: ["cast"],
  },
  {
    id: "bright-edge",
    phrase: "高频略收、不尖啸",
    textureBands: ["bright"],
  },
  {
    id: "dark-grain",
    phrase: "低部略带颗粒、不糊",
    textureBands: ["dark_raspy"],
  },
  {
    id: "airy-soft-tail",
    phrase: "句尾可轻气、主体实声",
    textureBands: ["airy"],
    energyBands: ["even", "heavy"],
  },
];

/** identity 禁止子串（听感/安全代理；非人耳门禁） */
export const DESIGN_PROMPT_BANNED_SUBSTRINGS: string[] = [
  "请听",
  "合适",
  "是否合适",
  "我的声音",
  "在祠堂",
  "走上",
  "周杰伦",
  "邓紫棋",
  "易烊千玺",
  "配音员",
  "明星",
];

/** 灌水同义垫片：body 已有吐字/气质时不再二次堆砌 */
export const DESIGN_PROMPT_PADDING_PHRASES: string[] = [
  "吐字清楚",
  "吐字清楚有主心骨",
  "气质克制坚定",
  "符合角色身份",
  "情绪自然",
];

/** 与 planner TEXTURE_CONFLICT_HINTS 对齐的本地对立检测（防循环 import） */
const QUIRK_TEXTURE_CONFLICT: Record<QuirkTextureBand, RegExp> = {
  bright: /沙哑|低沉|沉稳|沧桑|粗|哑|暗|厚|冷硬|气声|虚|飘|薄|柔弱|靠后|颗粒/,
  neutral: /沙哑|气声|虚|飘|软糯|过甜|过亮刺耳/,
  dark_raspy: /清亮|甜|脆|明快|灵动|俏|软糯|气声|虚|飘|明亮|偏亮|尖啸/,
  airy: /沙哑|低沉|沉稳|沧桑|粗|哑|厚|威严|冷硬|浑|颗粒|不压喉/,
};

function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function quirkPhraseConflictsTexture(
  phrase: string,
  textureBand: QuirkTextureBand,
): boolean {
  return QUIRK_TEXTURE_CONFLICT[textureBand].test(phrase);
}

/** 候选是否与 slot/cluster 兼容（表过滤 + texture 对立） */
export function isSpeechQuirkCompatible(
  seed: SpeechQuirkSeed,
  slot: QuirkSlot,
  cluster: QuirkCluster,
): boolean {
  if (seed.textureBands && seed.textureBands.length > 0) {
    if (!seed.textureBands.includes(slot.textureBand)) return false;
  }
  if (seed.energyBands && seed.energyBands.length > 0) {
    if (!seed.energyBands.includes(slot.energyBand)) return false;
  }
  if (seed.clusters && seed.clusters.length > 0) {
    if (!seed.clusters.includes(cluster)) return false;
  }
  if (quirkPhraseConflictsTexture(seed.phrase, slot.textureBand)) {
    return false;
  }
  // energy 粗冲突
  if (slot.energyBand === "lively") {
    if (seed.id === "heavy-pace") return false;
    if (/偏稳|沉稳/.test(seed.phrase) && seed.id !== "lead-center") return false;
  }
  if (slot.energyBand === "heavy") {
    if (seed.id === "lively-pace") return false;
    if (/轻扬|略快|轻快/.test(seed.phrase)) return false;
  }
  return true;
}

export function listCompatibleSpeechQuirks(
  slot: QuirkSlot,
  cluster: QuirkCluster,
): SpeechQuirkSeed[] {
  return SPEECH_QUIRK_SEEDS.filter((s) => isSpeechQuirkCompatible(s, slot, cluster));
}

/**
 * 选 1 条声学癖好；无兼容则 null。
 * 同 slot 多候选用 characterId 稳定打散。
 */
export function pickSpeechQuirk(input: {
  slot: QuirkSlot;
  cluster: QuirkCluster;
  characterId?: string | null;
}): string | null {
  const list = listCompatibleSpeechQuirks(input.slot, input.cluster);
  if (list.length === 0) return null;
  const key = (input.characterId || "").trim() || "0";
  const idx =
    stableHash(
      `${key}|${input.slot.pitchBand}|${input.slot.textureBand}|${input.slot.energyBand}|${input.cluster}`,
    ) % list.length;
  return list[idx]?.phrase ?? null;
}

/**
 * 兼容旧 speechHabitCandidates 调用面：返回「最多 1 条」。
 * 听感规约：禁止多条灌 soft-target。
 */
export function speechQuirkCandidates(
  slot: QuirkSlot,
  cluster: QuirkCluster,
  characterId?: string | null,
): string[] {
  const one = pickSpeechQuirk({ slot, cluster, characterId });
  return one ? [one] : [];
}

export function isPaddingFlavorPhrase(phrase: string): boolean {
  const p = phrase.trim();
  if (!p) return true;
  return DESIGN_PROMPT_PADDING_PHRASES.some((x) => p === x || p.includes("符合角色"));
}

export function containsBannedDesignPromptSubstring(prompt: string): string | null {
  for (const bad of DESIGN_PROMPT_BANNED_SUBSTRINGS) {
    if (prompt.includes(bad)) return bad;
  }
  return null;
}

/**
 * 从 design prompt 抽「质感字面 ∪ 癖好」代理 token（Jaccard 用）。
 */
export function extractAcousticIdentityTokens(prompt: string): Set<string> {
  const text = (prompt || "").replace(/\s+/g, "");
  const tokens = new Set<string>();
  const texture = text.match(/质感([^，。；\n]{1,16})/);
  if (texture?.[1]) tokens.add(`tx:${texture[1]}`);
  for (const seed of SPEECH_QUIRK_SEEDS) {
    if (text.includes(seed.phrase)) {
      tokens.add(`qk:${seed.id}`);
    }
  }
  for (const m of text.matchAll(
    /(清亮|沙哑|气声|金属|颗粒|软糯|沉稳|轻扬|靠后|不刺耳|不虚飘|不压喉|主心骨|轻快清脆|偏薄略干)[^，。]{0,6}/g,
  )) {
    if (m[0]) tokens.add(`fx:${m[0].slice(0, 12)}`);
  }
  return tokens;
}

export function jaccardIndex(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}
