/**
 * 品类 beat 配额（纯函数）：从 sellingPoint / competingFeel / first30ChapterPromise
 * 推导前 N 章养成/收集等占比目标，并提供近窗场景 Jaccard 多样性信号。
 *
 * 交付状态（两套近窗，勿混为一谈）：
 * - quality-debt board：`genreBeatSnapshot.sceneDiversity` = **品类前 N 章**内
 *   近 diversityWindow 的观测（recommendForce + advisory）；用于债板展示。
 * - 章节生成：`buildSceneDiversityForceDirective` 在 Assembler 用 **当前章前序 N 章**
 *   重算 → writeContext 仅软注入 `riskNotes` + `recentScenePatterns`。
 * - **禁止**写入 doNotCross / forbiddenCrossings（acceptance 硬合同）。
 * - 场景多样性 **仍不**接 volumeReplanGate / 导演熔断（仅 soft-force）。
 * - 品类主配额：满窗且 `meetsPrimaryQuota=false` 时，pipeline 可调用
 *   `shouldPauseForGenreBeatShortfall` 暂停后续章（与 diversity recommendForce 无关）。
 */

/** 近窗场景多样性默认窗口（章数） */
export const GENRE_BEAT_SCENE_DIVERSITY_WINDOW = 5;
/** 近窗平均 bi-gram Jaccard 达到该阈值则 shouldForce */
export const GENRE_BEAT_SCENE_DIVERSITY_THRESHOLD = 0.55;

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

export interface GenreBeatShortfall {
  kind: GenreBeatKind;
  /**
   * 当前进度口径下限：窗口未满时按已标注章数 * targetRatio 取 ceil；
   * 满窗时等于 fullWindowExpectedMin（= target.minChapters）。
   */
  expectedMin: number;
  /** 满窗绝对下限（ceil(windowSize * ratio)） */
  fullWindowExpectedMin: number;
  actual: number;
  labelZh: string;
}

export interface GenreBeatCoverageResult {
  windowSize: number;
  /** 实际参与计数的章数（≤ windowSize） */
  labeledChapterCount: number;
  /** complete=已标满窗；in_progress=未满窗，shortfall 用进度口径 */
  windowProgress: "in_progress" | "complete";
  counts: Record<GenreBeatKind, number>;
  ratios: Record<GenreBeatKind, number>;
  targets: GenreBeatQuotaTarget[];
  shortfalls: GenreBeatShortfall[];
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
  const labeledChapterCount = windowLabels.length;
  const windowProgress: "in_progress" | "complete" =
    labeledChapterCount >= windowSize ? "complete" : "in_progress";
  const counts = emptyCounts();
  for (const label of windowLabels) {
    counts[label] = (counts[label] ?? 0) + 1;
  }
  const denom = Math.max(1, labeledChapterCount);
  const ratios = emptyCounts();
  for (const kind of GENRE_BEAT_KINDS) {
    ratios[kind] = counts[kind] / denom;
  }
  const targets = buildGenreBeatQuotaTargets({
    windowSize,
    framing: input.framing,
    weights: input.weights,
  });
  const shortfalls: GenreBeatShortfall[] = targets
    .map((target) => {
      const fullWindowExpectedMin = target.minChapters;
      // 未满窗：按已标注进度计下限，避免 5 章时仍显示 0/10 满窗假债
      const expectedMin = labeledChapterCount === 0
        ? 0
        : windowProgress === "complete"
          ? fullWindowExpectedMin
          : Math.max(0, Math.ceil(labeledChapterCount * target.targetRatio));
      return {
        kind: target.kind,
        expectedMin,
        fullWindowExpectedMin,
        actual: counts[target.kind] ?? 0,
        labelZh: target.labelZh,
      };
    })
    .filter((item) => item.actual < item.expectedMin);
  // 主配额：权重最高两类均达到「当前口径」expectedMin（与 shortfall 同源）
  const primary = targets.slice(0, 2);
  const meetsPrimaryQuota = labeledChapterCount === 0
    || primary.length === 0
    || primary.every((target) => {
      const fullWindowExpectedMin = target.minChapters;
      const expectedMin = windowProgress === "complete"
        ? fullWindowExpectedMin
        : Math.max(0, Math.ceil(labeledChapterCount * target.targetRatio));
      return (counts[target.kind] ?? 0) >= expectedMin;
    });

  return {
    windowSize,
    labeledChapterCount,
    windowProgress,
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
  const window = input.window ?? GENRE_BEAT_SCENE_DIVERSITY_WINDOW;
  const threshold = input.threshold ?? GENRE_BEAT_SCENE_DIVERSITY_THRESHOLD;
  const averageJaccard = averageRollingSceneJaccard(input.recentTexts, window);
  return {
    shouldForce: averageJaccard >= threshold,
    averageJaccard,
    threshold,
    window,
  };
}

/**
 * 将 shouldForce 信号转为章节生成可消费的软约束。
 * advisory 恒 true：禁止调用方据此设置 volumeReplanGate.shouldPause。
 *
 * **刻意不进 doNotCross / forbiddenCrossings**：acceptance 把 forbidden_crossing
 * 当硬合同缺口；场景多样性只应写 riskNotes + scenePatterns（writer 可见、不 hard fail）。
 */
export interface SceneDiversityForceDirective {
  shouldForce: boolean;
  averageJaccard: number;
  threshold: number;
  window: number;
  advisory: true;
  riskNotes: string[];
  scenePatterns: string[];
  summaryLine: string | null;
}

function compactScenePattern(text: string, maxLength = 48): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function buildSceneDiversityForceDirective(input: {
  recentTexts: string[];
  window?: number;
  threshold?: number;
}): SceneDiversityForceDirective {
  const signal = shouldForceSceneDiversity(input);
  if (!signal.shouldForce) {
    return {
      shouldForce: false,
      averageJaccard: signal.averageJaccard,
      threshold: signal.threshold,
      window: signal.window,
      advisory: true,
      riskNotes: [],
      scenePatterns: [],
      summaryLine: null,
    };
  }

  const jLabel = signal.averageJaccard.toFixed(2);
  const riskNotes = [
    `scene_diversity_force: 写作近邻窗 Jaccard=${jLabel}≥${signal.threshold}，本章必须切换场景类型、地点或冲突骨架；禁止复用近${signal.window}章同质摘要/任务单的冲突推进方式与开场结构`,
  ];
  // 条目是近邻章摘要/任务 blob 截断，不是结构化 time+location；prompt 文案须与此一致
  const scenePatterns = Array.from(new Set(
    (input.recentTexts ?? [])
      .map((text) => compactScenePattern(text))
      .filter(Boolean),
  )).slice(-Math.max(2, signal.window));

  return {
    shouldForce: true,
    averageJaccard: signal.averageJaccard,
    threshold: signal.threshold,
    window: signal.window,
    advisory: true,
    riskNotes,
    scenePatterns,
    summaryLine: `近窗同质偏高(J=${jLabel})已注入换场景软约束`,
  };
}
