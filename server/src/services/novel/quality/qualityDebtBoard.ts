import {
  classifyChapterQualityLoopRisk,
  type ChapterQualityLoopAction,
  type ChapterQualityLoopRiskClassification,
  type ChapterQualityLoopSignalStatus,
} from "@ai-novel/shared/types/chapterQualityLoop";
import {
  classifyGenreBeatFromText,
  evaluateGenreBeatCoverage,
  shouldForceSceneDiversity,
  type GenreBeatCoverageResult,
  type GenreBeatKind,
  type GenreFramingInput,
} from "@ai-novel/shared/types/genreBeatQuota";

/**
 * 运行范围内（pipeline job 的 startOrder–endOrder，或债板聚合的章节集合）
 * blocking replan/manual_gate 累计达到该阈值时，停止后续自动成书。
 * 注意：不是物理「卷」实体；命名保留 volume 前缀以兼容已发布 API 字段。
 */
export const QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD = 3;

/** 品类 beat 报告默认窗口（前 N 章）。 */
export const GENRE_BEAT_BOARD_WINDOW_SIZE = 30;
/** 近窗场景 Jaccard 多样性窗口。 */
export const GENRE_BEAT_SCENE_DIVERSITY_WINDOW = 5;

export interface QualityDebtChapterRow {
  id?: string;
  order?: number;
  title?: string | null;
  generationState?: string | null;
  chapterStatus?: string | null;
  riskFlags?: string | null;
}

export interface QualityDebtBoardItem {
  chapterId: string;
  chapterOrder: number;
  title: string | null;
  generationState: string | null;
  chapterStatus: string | null;
  overallStatus: ChapterQualityLoopSignalStatus | null;
  recommendedAction: ChapterQualityLoopAction | null;
  rootCauseCode: string | null;
  terminalAction: string | null;
  riskClassification: ChapterQualityLoopRiskClassification;
  evaluatedAt: string | null;
  pauseReason: string | null;
}

export interface QualityDebtBoardSummary {
  totalWithQualityLoop: number;
  invalidCount: number;
  riskCount: number;
  validCount: number;
  patchRepairCount: number;
  replanCount: number;
  manualGateCount: number;
  blockingCount: number;
  nonBlockingDebtCount: number;
  blockingReplanCount: number;
}

export interface VolumeReplanQualityDebtGate {
  threshold: number;
  blockingReplanCount: number;
  shouldPause: boolean;
  reason: string | null;
  /** 计数作用域：range=指定章节序区间；board=传入章节集合（通常为全书债板） */
  scope: "range" | "board";
  startOrder: number | null;
  endOrder: number | null;
}

/**
 * 品类 beat 观测快照（只读报告，不熔断 auto director）。
 * status=observed：已接线 quality-debt；强制换场景仍由调用方决定。
 */
export interface GenreBeatBoardSnapshot {
  status: "observed";
  windowSize: number;
  labeledChapterCount: number;
  coverage: GenreBeatCoverageResult;
  chapterBeatKinds: Array<{
    chapterOrder: number;
    kind: GenreBeatKind;
  }>;
  /**
   * 近窗多样性观测。recommendForce 仅为建议，**不**等同 volumeReplanGate.shouldPause。
   * advisory 恒为 true，防止被误接导演熔断。
   */
  sceneDiversity: {
    recommendForce: boolean;
    averageJaccard: number;
    threshold: number;
    window: number;
    advisory: true;
  };
  /** 人类可读摘要（含 shortfall 细节，UI 可只渲染本行） */
  summaryLine: string;
}

export interface QualityDebtBoardResult {
  novelId: string;
  items: QualityDebtBoardItem[];
  summary: QualityDebtBoardSummary;
  volumeReplanGate: VolumeReplanQualityDebtGate;
  /** 品类 beat / 近窗多样性观测；无章文本时仍返回空覆盖结构 */
  genreBeatSnapshot: GenreBeatBoardSnapshot | null;
}

export interface GenreBeatChapterLabelSource {
  order: number;
  title?: string | null;
  taskSheet?: string | null;
  summary?: string | null;
  purpose?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseQualityLoopFromRiskFlags(
  riskFlags: string | null | undefined,
): Record<string, unknown> | null {
  if (!riskFlags?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(riskFlags) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const qualityLoop = parsed.qualityLoop;
    return isRecord(qualityLoop) ? qualityLoop : null;
  } catch {
    return null;
  }
}

export function isBlockingReplanQualityDebt(
  qualityLoop: Record<string, unknown> | null | undefined,
): boolean {
  if (!qualityLoop) {
    return false;
  }
  if (qualityLoop.rootCauseCode === "replan_required" || qualityLoop.recommendedAction === "replan") {
    return true;
  }
  if (qualityLoop.recommendedAction === "manual_gate") {
    return true;
  }
  const budget = isRecord(qualityLoop.budget) ? qualityLoop.budget : null;
  if (budget?.nextAction === "replan_window" || budget?.nextAction === "hard_stop") {
    return true;
  }
  return false;
}

export function filterChaptersByOrderRange<T extends { order?: number | null }>(
  chapters: T[],
  range?: { startOrder?: number | null; endOrder?: number | null } | null,
): T[] {
  const start = range?.startOrder;
  const end = range?.endOrder;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
    return chapters;
  }
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return chapters.filter((chapter) => {
    if (typeof chapter.order !== "number" || !Number.isFinite(chapter.order)) {
      return false;
    }
    return chapter.order >= lo && chapter.order <= hi;
  });
}

export function countBlockingReplanQualityDebts(
  chapters: Array<Pick<QualityDebtChapterRow, "riskFlags" | "order">>,
  range?: { startOrder?: number | null; endOrder?: number | null } | null,
): number {
  const scoped = filterChaptersByOrderRange(chapters, range);
  let count = 0;
  for (const chapter of scoped) {
    const qualityLoop = parseQualityLoopFromRiskFlags(chapter.riskFlags);
    if (isBlockingReplanQualityDebt(qualityLoop)) {
      count += 1;
    }
  }
  return count;
}

export function shouldPauseVolumeForReplanQualityDebt(
  blockingReplanCount: number,
  threshold: number = QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD,
): boolean {
  return blockingReplanCount >= Math.max(1, threshold);
}

function formatGateScopeLabel(input: {
  scope: "range" | "board";
  startOrder: number | null;
  endOrder: number | null;
}): string {
  if (
    input.scope === "range"
    && typeof input.startOrder === "number"
    && typeof input.endOrder === "number"
  ) {
    if (input.startOrder === input.endOrder) {
      return `第 ${input.startOrder} 章运行范围`;
    }
    return `第 ${input.startOrder}-${input.endOrder} 章运行范围`;
  }
  return "当前债板章节范围";
}

export function buildVolumeReplanQualityDebtGate(input: {
  chapters: Array<Pick<QualityDebtChapterRow, "riskFlags" | "order">>;
  threshold?: number;
  /** 流水线/导演 job 的章节序闭区间；缺省则对传入 chapters 全集计数（债板默认全书） */
  startOrder?: number | null;
  endOrder?: number | null;
}): VolumeReplanQualityDebtGate {
  const threshold = input.threshold ?? QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD;
  const hasRange = typeof input.startOrder === "number"
    && typeof input.endOrder === "number"
    && Number.isFinite(input.startOrder)
    && Number.isFinite(input.endOrder);
  const startOrder = hasRange ? Math.min(input.startOrder!, input.endOrder!) : null;
  const endOrder = hasRange ? Math.max(input.startOrder!, input.endOrder!) : null;
  const scope: "range" | "board" = hasRange ? "range" : "board";
  const blockingReplanCount = countBlockingReplanQualityDebts(
    input.chapters,
    hasRange ? { startOrder, endOrder } : null,
  );
  const shouldPause = shouldPauseVolumeForReplanQualityDebt(blockingReplanCount, threshold);
  const scopeLabel = formatGateScopeLabel({ scope, startOrder, endOrder });
  return {
    threshold,
    blockingReplanCount,
    shouldPause,
    scope,
    startOrder,
    endOrder,
    reason: shouldPause
      ? `${scopeLabel}内阻塞性 replan/manual_gate 质量债累计 ${blockingReplanCount} 章（阈值 ${threshold}），已暂停后续自动成书。`
      : null,
  };
}

function asStatus(value: unknown): ChapterQualityLoopSignalStatus | null {
  return value === "valid" || value === "risk" || value === "invalid" || value === "missing"
    ? value
    : null;
}

function asAction(value: unknown): ChapterQualityLoopAction | null {
  return value === "continue"
    || value === "patch_repair"
    || value === "replan"
    || value === "manual_gate"
    ? value
    : null;
}

export function buildQualityDebtBoardItem(
  chapter: Required<Pick<QualityDebtChapterRow, "id" | "order">> & QualityDebtChapterRow,
): QualityDebtBoardItem | null {
  const qualityLoop = parseQualityLoopFromRiskFlags(chapter.riskFlags);
  if (!qualityLoop) {
    return null;
  }
  const riskClassification = classifyChapterQualityLoopRisk(qualityLoop);
  if (
    riskClassification === "none"
    && qualityLoop.overallStatus === "valid"
    && qualityLoop.recommendedAction === "continue"
  ) {
    return null;
  }
  return {
    chapterId: chapter.id,
    chapterOrder: chapter.order,
    title: chapter.title ?? null,
    generationState: chapter.generationState ?? null,
    chapterStatus: chapter.chapterStatus ?? null,
    overallStatus: asStatus(qualityLoop.overallStatus),
    recommendedAction: asAction(qualityLoop.recommendedAction),
    rootCauseCode: typeof qualityLoop.rootCauseCode === "string" ? qualityLoop.rootCauseCode : null,
    terminalAction: typeof qualityLoop.terminalAction === "string" ? qualityLoop.terminalAction : null,
    riskClassification,
    evaluatedAt: typeof qualityLoop.evaluatedAt === "string" ? qualityLoop.evaluatedAt : null,
    pauseReason: typeof qualityLoop.pauseReason === "string" ? qualityLoop.pauseReason : null,
  };
}

export function buildQualityDebtBoardSummary(items: QualityDebtBoardItem[]): QualityDebtBoardSummary {
  const summary: QualityDebtBoardSummary = {
    totalWithQualityLoop: items.length,
    invalidCount: 0,
    riskCount: 0,
    validCount: 0,
    patchRepairCount: 0,
    replanCount: 0,
    manualGateCount: 0,
    blockingCount: 0,
    nonBlockingDebtCount: 0,
    blockingReplanCount: 0,
  };
  for (const item of items) {
    if (item.overallStatus === "invalid") summary.invalidCount += 1;
    else if (item.overallStatus === "risk") summary.riskCount += 1;
    else if (item.overallStatus === "valid") summary.validCount += 1;
    if (item.recommendedAction === "patch_repair") summary.patchRepairCount += 1;
    if (item.recommendedAction === "replan") summary.replanCount += 1;
    if (item.recommendedAction === "manual_gate") summary.manualGateCount += 1;
    if (item.riskClassification === "blocking") summary.blockingCount += 1;
    if (item.riskClassification === "non_blocking_quality_debt") summary.nonBlockingDebtCount += 1;
    if (
      item.recommendedAction === "replan"
      || item.recommendedAction === "manual_gate"
      || item.rootCauseCode === "replan_required"
    ) {
      summary.blockingReplanCount += 1;
    }
  }
  return summary;
}

export function buildGenreBeatBoardSnapshot(input: {
  framing?: GenreFramingInput | null;
  chapters: GenreBeatChapterLabelSource[];
  windowSize?: number;
  diversityWindow?: number;
}): GenreBeatBoardSnapshot {
  const windowSize = Math.max(1, Math.floor(input.windowSize ?? GENRE_BEAT_BOARD_WINDOW_SIZE));
  const diversityWindow = Math.max(2, Math.floor(input.diversityWindow ?? GENRE_BEAT_SCENE_DIVERSITY_WINDOW));
  const ordered = [...input.chapters]
    .filter((chapter) => typeof chapter.order === "number" && Number.isFinite(chapter.order))
    .sort((left, right) => left.order - right.order)
    .slice(0, windowSize);

  const chapterBeatKinds = ordered.map((chapter) => {
    const blob = [
      chapter.title,
      chapter.taskSheet,
      chapter.summary,
      chapter.purpose,
    ].filter(Boolean).join("\n");
    return {
      chapterOrder: chapter.order,
      kind: classifyGenreBeatFromText(blob),
    };
  });
  const coverage = evaluateGenreBeatCoverage({
    chapterLabels: chapterBeatKinds.map((item) => item.kind),
    windowSize,
    framing: input.framing ?? null,
  });
  const recentTexts = ordered
    .map((chapter) => [
      chapter.title,
      chapter.summary,
      chapter.taskSheet,
      chapter.purpose,
    ].filter(Boolean).join(" "))
    .filter((text) => text.trim().length > 0);
  const diversitySignal = shouldForceSceneDiversity({
    recentTexts: recentTexts.slice(-diversityWindow),
    window: diversityWindow,
  });
  const sceneDiversity = {
    recommendForce: diversitySignal.shouldForce,
    averageJaccard: diversitySignal.averageJaccard,
    threshold: diversitySignal.threshold,
    window: diversitySignal.window,
    advisory: true as const,
  };
  const shortfallText = coverage.shortfalls.length > 0
    ? coverage.shortfalls
      .map((item) => (
        coverage.windowProgress === "in_progress"
          ? `${item.labelZh}${item.actual}/${item.expectedMin}(满窗${item.fullWindowExpectedMin})`
          : `${item.labelZh}${item.actual}/${item.expectedMin}`
      ))
      .join("、")
    : "主配额无 shortfall";
  const quotaPhrase = coverage.labeledChapterCount === 0
    ? "尚无章可标注"
    : coverage.windowProgress === "in_progress"
      ? (coverage.meetsPrimaryQuota ? "主配额进度正常" : "主配额进度落后")
      : (coverage.meetsPrimaryQuota ? "主配额达标" : "主配额未达标");
  const summaryLine = [
    `前${coverage.windowSize}章已标注${chapterBeatKinds.length}`,
    quotaPhrase,
    shortfallText,
    sceneDiversity.recommendForce
      ? `近窗同质偏高(J=${sceneDiversity.averageJaccard.toFixed(2)})建议换场景`
      : `近窗多样性可接受(J=${sceneDiversity.averageJaccard.toFixed(2)})`,
  ].join("；");

  return {
    status: "observed",
    windowSize: coverage.windowSize,
    labeledChapterCount: chapterBeatKinds.length,
    coverage,
    chapterBeatKinds,
    sceneDiversity,
    summaryLine,
  };
}

export function buildQualityDebtBoardResult(input: {
  novelId: string;
  chapters: Array<Required<Pick<QualityDebtChapterRow, "id" | "order">> & QualityDebtChapterRow>;
  threshold?: number;
  /** 可选：将 volumeReplanGate 限制在该序区间（默认对传入 chapters 全集） */
  gateStartOrder?: number | null;
  gateEndOrder?: number | null;
  /** 可选：品类 framing + 章文本；缺省则 genreBeatSnapshot=null */
  genreBeat?: {
    framing?: GenreFramingInput | null;
    chapters?: GenreBeatChapterLabelSource[] | null;
    windowSize?: number;
    diversityWindow?: number;
  } | null;
}): QualityDebtBoardResult {
  const items = input.chapters
    .map((chapter) => buildQualityDebtBoardItem(chapter))
    .filter((item): item is QualityDebtBoardItem => item != null)
    .sort((left, right) => left.chapterOrder - right.chapterOrder || left.chapterId.localeCompare(right.chapterId));
  const summary = buildQualityDebtBoardSummary(items);
  const volumeReplanGate = buildVolumeReplanQualityDebtGate({
    chapters: input.chapters,
    threshold: input.threshold,
    startOrder: input.gateStartOrder,
    endOrder: input.gateEndOrder,
  });
  // keep summary aligned with gate counter
  summary.blockingReplanCount = volumeReplanGate.blockingReplanCount;
  const genreBeatSnapshot = input.genreBeat
    ? buildGenreBeatBoardSnapshot({
      framing: input.genreBeat.framing,
      chapters: input.genreBeat.chapters ?? [],
      windowSize: input.genreBeat.windowSize,
      diversityWindow: input.genreBeat.diversityWindow,
    })
    : null;
  return {
    novelId: input.novelId,
    items,
    summary,
    volumeReplanGate,
    genreBeatSnapshot,
  };
}
