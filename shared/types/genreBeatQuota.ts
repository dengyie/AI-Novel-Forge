/**
 * 品类 beat 配额（纯函数）：从 sellingPoint / competingFeel / first30ChapterPromise
 * 推导前 N 章养成/收集等占比目标，并提供近窗场景 Jaccard 多样性信号。
 *
 * 交付状态：library-ready / partial — 已 export + 单测，**尚未**接入 director /
 * rolling_window / volume 报告。调用方自行决定是否强制换场景；勿宣称运行时已生效。
 */

export const GENRE_BEAT_KINDS = [
  "nurture",
  "collect",
  "combat",
  "explore",
  "transition",
  "other",
] as const;

export type GenreBeatKind = typeof GENRE_BEAT_KINDS[number];

export interface GenreFramingInput {
  sellingPoint?: string | null;
  competingFeel?: string | null;
  first30ChapterPromise?: string | null;
}

export interface GenreBeatQuotaTarget {
  kind: GenreBeatKind;
  /** 0-1 目标占比 */
  targetRatio: number;
  /** 窗口内最少章数（ceil） */
  minChapters: number;
  labelZh: string;
}

export interface GenreBeatCoverageResult {
  windowSize: number;
  counts: Record<GenreBeatKind, number>;
  ratios: Record<GenreBeatKind, number>;
  targets: GenreBeatQuotaTarget[];
  shortfalls: Array<{
    kind: GenreBeatKind;
    expectedMin: number;
    actual: number;
    labelZh: string;
  }>;
  meetsPrimaryQuota: boolean;
}

const LABEL_ZH: Record<GenreBeatKind, string> = {
  nurture: "养成/关系",
  collect: "收集/资源",
  combat: "战斗/对抗",
  explore: "探索/发现",
  transition: "过渡/转场",
  other: "其他",
};

function framingBlob(input: GenreFramingInput): string {
  return [
    input.sellingPoint,
    input.competingFeel,
    input.first30ChapterPromise,
  ].filter(Boolean).join("\n");
}

function scoreFramingKinds(blob: string): Record<GenreBeatKind, number> {
  const text = blob.toLowerCase();
  const score: Record<GenreBeatKind, number> = {
    nurture: 0,
    collect: 0,
    combat: 0,
    explore: 0,
    transition: 0,
    other: 0,
  };
  const bump = (kind: GenreBeatKind, weight: number, patterns: RegExp[]) => {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        score[kind] += weight;
      }
    }
  };
  bump("nurture", 3, [/养成|轻松|日常|关系|羁绊|陪伴|恋爱|甜|成长曲线|训练日常/]);
  bump("collect", 3, [/收集|资源|打宝|掉落|材料|背包|图纸|灵石|收获|囤货/]);
  bump("combat", 2, [/战斗|对决|升级打怪|杀伐|热血|爽点战斗|高压/]);
  bump("explore", 2, [/探索|冒险|地图|秘境|副本|发现|调查/]);
  bump("transition", 1, [/过渡|铺垫|衔接|节奏/]);
  return score;
}

/** 从卖点/竞品感/前30承诺推断各 beat 目标权重（未归一）。 */
export function inferGenreBeatWeights(input: GenreFramingInput): Record<GenreBeatKind, number> {
  const scores = scoreFramingKinds(framingBlob(input));
  const sum = GENRE_BEAT_KINDS.reduce((acc, kind) => acc + scores[kind], 0);
  if (sum <= 0) {
    // 默认偏养成+收集（样板门禁「轻松养成」方向），其余少量战斗/探索/过渡
    return {
      nurture: 0.35,
      collect: 0.25,
      combat: 0.15,
      explore: 0.15,
      transition: 0.1,
      other: 0,
    };
  }
  const weights = {} as Record<GenreBeatKind, number>;
  for (const kind of GENRE_BEAT_KINDS) {
    weights[kind] = scores[kind] / sum;
  }
  return weights;
}

export function buildGenreBeatQuotaTargets(input: {
  windowSize?: number;
  framing?: GenreFramingInput | null;
  weights?: Partial<Record<GenreBeatKind, number>> | null;
  /** 只对权重≥该值的 kind 生成 min 约束 */
  minWeightToEnforce?: number;
}): GenreBeatQuotaTarget[] {
  const windowSize = Math.max(1, Math.floor(input.windowSize ?? 30));
  const weights = {
    ...inferGenreBeatWeights(input.framing ?? {}),
    ...(input.weights ?? {}),
  } as Record<GenreBeatKind, number>;
  const minWeight = input.minWeightToEnforce ?? 0.12;
  const targets: GenreBeatQuotaTarget[] = [];
  for (const kind of GENRE_BEAT_KINDS) {
    if (kind === "other") {
      continue;
    }
    const ratio = Math.max(0, Math.min(1, weights[kind] ?? 0));
    if (ratio < minWeight) {
      continue;
    }
    targets.push({
      kind,
      targetRatio: ratio,
      minChapters: Math.max(1, Math.ceil(windowSize * ratio)),
      labelZh: LABEL_ZH[kind],
    });
  }
  return targets.sort((a, b) => b.targetRatio - a.targetRatio);
}

export function classifyGenreBeatFromText(text: string | null | undefined): GenreBeatKind {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return "other";
  }
  const scores = scoreFramingKinds(raw);
  // 单章分类时用更贴章的关键词加权
  if (/养成|训练|关系|羁绊|陪伴|告白|和解/.test(raw)) scores.nurture += 2;
  if (/收集|入手|掉落|材料|资源|灵石|图纸/.test(raw)) scores.collect += 2;
  if (/战斗|对决|厮杀|伏击|突围|交手/.test(raw)) scores.combat += 2;
  if (/探索|调查|遗迹|线索|潜入/.test(raw)) scores.explore += 2;
  if (/过渡|赶路|休整|安顿|转场/.test(raw)) scores.transition += 2;
  let best: GenreBeatKind = "other";
  let bestScore = 0;
  for (const kind of GENRE_BEAT_KINDS) {
    if (kind === "other") continue;
    if (scores[kind] > bestScore) {
      best = kind;
      bestScore = scores[kind];
    }
  }
  return bestScore > 0 ? best : "other";
}

function emptyCounts(): Record<GenreBeatKind, number> {
  return {
    nurture: 0,
    collect: 0,
    combat: 0,
    explore: 0,
    transition: 0,
    other: 0,
  };
}

export function evaluateGenreBeatCoverage(input: {
  chapterLabels: GenreBeatKind[];
  windowSize?: number;
  framing?: GenreFramingInput | null;
  weights?: Partial<Record<GenreBeatKind, number>> | null;
}): GenreBeatCoverageResult {
  const windowSize = Math.max(
    1,
    Math.floor(input.windowSize ?? (input.chapterLabels.length || 30)),
  );
  const windowLabels = input.chapterLabels.slice(0, windowSize);
  const counts = emptyCounts();
  for (const label of windowLabels) {
    counts[label] = (counts[label] ?? 0) + 1;
  }
  const denom = Math.max(1, windowLabels.length);
  const ratios = emptyCounts();
  for (const kind of GENRE_BEAT_KINDS) {
    ratios[kind] = counts[kind] / denom;
  }
  const targets = buildGenreBeatQuotaTargets({
    windowSize,
    framing: input.framing,
    weights: input.weights,
  });
  const shortfalls = targets
    .map((target) => ({
      kind: target.kind,
      expectedMin: target.minChapters,
      actual: counts[target.kind] ?? 0,
      labelZh: target.labelZh,
    }))
    .filter((item) => item.actual < item.expectedMin);
  // 主配额：权重最高的两类（通常养成/收集）都达标则 true；窗口未满时仅检查已有 targets 的比例
  const primary = targets.slice(0, 2);
  const meetsPrimaryQuota = primary.length === 0
    || primary.every((target) => (counts[target.kind] ?? 0) >= target.minChapters
      || windowLabels.length < windowSize && ratios[target.kind] + 1e-9 >= target.targetRatio * 0.85);

  return {
    windowSize,
    counts,
    ratios,
    targets,
    shortfalls,
    meetsPrimaryQuota,
  };
}

function normalizeForNgram(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}一-鿿]/gu, "");
}

function buildBiGramSet(text: string): Set<string> {
  const normalized = normalizeForNgram(text);
  const grams = new Set<string>();
  if (!normalized) {
    return grams;
  }
  if (normalized.length <= 2) {
    grams.add(normalized);
    return grams;
  }
  for (let i = 0; i <= normalized.length - 2; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
}

export function jaccardBiGramSimilarity(left: string, right: string): number {
  const a = buildBiGramSet(left);
  const b = buildBiGramSet(right);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 近 window 章两两平均 Jaccard；过高表示场景/摘要同质。 */
export function averageRollingSceneJaccard(
  recentTexts: string[],
  window = 5,
): number {
  const slice = recentTexts.filter((item) => item?.trim()).slice(-Math.max(2, window));
  if (slice.length < 2) {
    return 0;
  }
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < slice.length; i += 1) {
    for (let j = i + 1; j < slice.length; j += 1) {
      sum += jaccardBiGramSimilarity(slice[i], slice[j]);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : sum / pairs;
}

export function shouldForceSceneDiversity(input: {
  recentTexts: string[];
  window?: number;
  /** 默认 0.55：近窗平均 bi-gram Jaccard 过高则建议换场景 */
  threshold?: number;
}): {
  shouldForce: boolean;
  averageJaccard: number;
  threshold: number;
  window: number;
} {
  const window = input.window ?? 5;
  const threshold = input.threshold ?? 0.55;
  const averageJaccard = averageRollingSceneJaccard(input.recentTexts, window);
  return {
    shouldForce: averageJaccard >= threshold,
    averageJaccard,
    threshold,
    window,
  };
}
