import {
  classifyChapterQualityLoopRisk,
  type ChapterQualityLoopAction,
  type ChapterQualityLoopRiskClassification,
  type ChapterQualityLoopSignalStatus,
} from "@ai-novel/shared/types/chapterQualityLoop";

/**
 * 运行范围内（pipeline job 的 startOrder–endOrder，或债板聚合的章节集合）
 * blocking replan/manual_gate 累计达到该阈值时，停止后续自动成书。
 * 注意：不是物理「卷」实体；命名保留 volume 前缀以兼容已发布 API 字段。
 */
export const QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD = 3;

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

export interface QualityDebtBoardResult {
  novelId: string;
  items: QualityDebtBoardItem[];
  summary: QualityDebtBoardSummary;
  volumeReplanGate: VolumeReplanQualityDebtGate;
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

export function buildQualityDebtBoardResult(input: {
  novelId: string;
  chapters: Array<Required<Pick<QualityDebtChapterRow, "id" | "order">> & QualityDebtChapterRow>;
  threshold?: number;
  /** 可选：将 volumeReplanGate 限制在该序区间（默认对传入 chapters 全集） */
  gateStartOrder?: number | null;
  gateEndOrder?: number | null;
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
  return {
    novelId: input.novelId,
    items,
    summary,
    volumeReplanGate,
  };
}
