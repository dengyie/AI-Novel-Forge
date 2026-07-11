import {
  classifyChapterQualityLoopRisk,
  type ChapterQualityLoopAction,
  type ChapterQualityLoopRiskClassification,
  type ChapterQualityLoopSignalStatus,
} from "@ai-novel/shared/types/chapterQualityLoop";

/** 卷内 blocking replan/manual_gate 累计达到该阈值时，流水线停止后续自动成书。 */
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

export function countBlockingReplanQualityDebts(
  chapters: Array<Pick<QualityDebtChapterRow, "riskFlags">>,
): number {
  let count = 0;
  for (const chapter of chapters) {
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

export function buildVolumeReplanQualityDebtGate(input: {
  chapters: Array<Pick<QualityDebtChapterRow, "riskFlags">>;
  threshold?: number;
}): VolumeReplanQualityDebtGate {
  const threshold = input.threshold ?? QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD;
  const blockingReplanCount = countBlockingReplanQualityDebts(input.chapters);
  const shouldPause = shouldPauseVolumeForReplanQualityDebt(blockingReplanCount, threshold);
  return {
    threshold,
    blockingReplanCount,
    shouldPause,
    reason: shouldPause
      ? `卷内阻塞性 replan/manual_gate 质量债累计 ${blockingReplanCount} 章（阈值 ${threshold}），已暂停后续自动成书。`
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
}): QualityDebtBoardResult {
  const items = input.chapters
    .map((chapter) => buildQualityDebtBoardItem(chapter))
    .filter((item): item is QualityDebtBoardItem => item != null)
    .sort((left, right) => left.chapterOrder - right.chapterOrder || left.chapterId.localeCompare(right.chapterId));
  const summary = buildQualityDebtBoardSummary(items);
  const volumeReplanGate = buildVolumeReplanQualityDebtGate({
    chapters: input.chapters,
    threshold: input.threshold,
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
