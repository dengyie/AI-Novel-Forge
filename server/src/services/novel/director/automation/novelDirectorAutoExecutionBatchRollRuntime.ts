import type { DirectorAutoExecutionState } from "@ai-novel/shared/types/novelDirector";
import { assessChapterExecutionContractShape } from "@ai-novel/shared/types/chapterTaskSheetQuality";
import type { DirectorAutoExecutionChapterRef, DirectorAutoExecutionRange } from "./novelDirectorAutoExecution";
import {
  buildDirectorAutoExecutionState,
  isDirectorAutoExecutionChapterProcessed,
} from "./novelDirectorAutoExecution";

export const DEFAULT_MAX_CONSECUTIVE_BATCH_ROLLS = 8;
export const DEFAULT_BATCH_ROLL_WINDOW_SIZE = 10;

export type BatchRollDecisionKind =
  | "completed_scope"
  | "expand_range"
  | "reenter_structured_outline"
  | "halt_for_review";

export type BatchRollWindow = {
  startOrder: number;
  endOrder: number;
};

export type BatchRollDecision = {
  kind: BatchRollDecisionKind;
  reason: string;
  nextRange?: BatchRollWindow;
};

export type BatchRollChapterReadiness = {
  order: number;
  hasTitle: boolean;
  canEnterExecution: boolean;
  isProcessed: boolean;
};

/**
 * Group contiguous chapter orders into the first window starting at or after `afterOrder`.
 */
export function resolveContiguousWindowFromOrders(
  orders: number[],
  afterOrder: number,
  maxWindowSize: number = DEFAULT_BATCH_ROLL_WINDOW_SIZE,
): BatchRollWindow | null {
  const sorted = [...new Set(orders)]
    .filter((order) => Number.isFinite(order) && order > afterOrder)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const startOrder = sorted[0]!;
  let endOrder = startOrder;
  for (let index = 1; index < sorted.length; index += 1) {
    const order = sorted[index]!;
    if (order !== endOrder + 1) {
      break;
    }
    if ((order - startOrder + 1) > maxWindowSize) {
      break;
    }
    endOrder = order;
  }
  const span = endOrder - startOrder + 1;
  if (span > maxWindowSize) {
    endOrder = startOrder + maxWindowSize - 1;
  }
  return { startOrder, endOrder };
}

/**
 * Next contiguous window of chapters that still need outline/execution-contract prep.
 * Prefer chapters that have a title (exist in workspace/list) but cannot enter execution.
 */
export function resolveNextUnpreparedWindow(input: {
  afterOrder: number;
  readiness: BatchRollChapterReadiness[];
  maxWindowSize?: number;
}): BatchRollWindow | null {
  const maxWindowSize = input.maxWindowSize ?? DEFAULT_BATCH_ROLL_WINDOW_SIZE;
  const orders = input.readiness
    .filter((item) => item.order > input.afterOrder && item.hasTitle && !item.canEnterExecution)
    .map((item) => item.order);
  return resolveContiguousWindowFromOrders(orders, input.afterOrder, maxWindowSize);
}

/**
 * Next contiguous window fully prepared for execution (contract ok) with at least one unprocessed chapter.
 */
export function resolveNextPreparedExecutableWindow(input: {
  afterOrder: number;
  readiness: BatchRollChapterReadiness[];
  maxWindowSize?: number;
}): BatchRollWindow | null {
  const maxWindowSize = input.maxWindowSize ?? DEFAULT_BATCH_ROLL_WINDOW_SIZE;
  const candidates = input.readiness
    .filter((item) => item.order > input.afterOrder && item.canEnterExecution)
    .sort((left, right) => left.order - right.order);
  if (candidates.length === 0) {
    return null;
  }
  const first = candidates[0]!;
  // Window must start at first prepared after current end (contiguous from first).
  const windowOrders: number[] = [];
  let expected = first.order;
  for (const item of candidates) {
    if (item.order !== expected) {
      break;
    }
    if (windowOrders.length >= maxWindowSize) {
      break;
    }
    windowOrders.push(item.order);
    expected += 1;
  }
  if (windowOrders.length === 0) {
    return null;
  }
  const window = {
    startOrder: windowOrders[0]!,
    endOrder: windowOrders[windowOrders.length - 1]!,
  };
  const hasWork = input.readiness.some((item) => (
    item.order >= window.startOrder
    && item.order <= window.endOrder
    && item.canEnterExecution
    && !item.isProcessed
  ));
  if (!hasWork) {
    // All prepared chapters in this window already processed — look further.
    return resolveNextPreparedExecutableWindow({
      afterOrder: window.endOrder,
      readiness: input.readiness,
      maxWindowSize,
    });
  }
  return window;
}

export function buildBatchRollReadinessFromChapters(
  chapters: Array<DirectorAutoExecutionChapterRef & {
    title?: string | null;
    purpose?: string | null;
    exclusiveEvent?: string | null;
    endingState?: string | null;
    nextChapterEntryState?: string | null;
  }>,
  options?: {
    settingQualityMode?: "off" | "advisory" | "enforce" | null;
    qualityMode?: "full_book_autopilot" | "ai_copilot" | "manual" | null;
  },
): BatchRollChapterReadiness[] {
  return chapters.map((chapter) => {
    const canEnterExecution = assessChapterExecutionContractShape({
      novelId: "batch-roll",
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      purpose: chapter.purpose ?? null,
      exclusiveEvent: chapter.exclusiveEvent ?? null,
      endingState: chapter.endingState ?? null,
      nextChapterEntryState: chapter.nextChapterEntryState ?? null,
      conflictLevel: chapter.conflictLevel ?? null,
      revealLevel: chapter.revealLevel ?? null,
      targetWordCount: chapter.targetWordCount ?? null,
      mustAvoid: chapter.mustAvoid ?? null,
      taskSheet: chapter.taskSheet ?? null,
      sceneCards: chapter.sceneCards ?? null,
      title: chapter.title ?? "",
    }, {
      settingQualityMode: options?.settingQualityMode ?? undefined,
      qualityMode: options?.qualityMode ?? undefined,
    }).canEnterExecution;
    return {
      order: chapter.order,
      hasTitle: Boolean(chapter.title?.trim()) || Boolean(chapter.taskSheet?.trim()) || canEnterExecution,
      canEnterExecution,
      isProcessed: isDirectorAutoExecutionChapterProcessed(chapter),
    };
  });
}

/**
 * Pure decision: what to do when the current auto-execution range has remaining=0.
 */
export function resolveNextAutoExecutionBatchRoll(input: {
  range: DirectorAutoExecutionRange;
  autoExecution: DirectorAutoExecutionState;
  nextUnpreparedWindow?: BatchRollWindow | null;
  nextPreparedExecutableWindow?: BatchRollWindow | null;
  consecutiveBatchRolls: number;
  maxConsecutiveBatchRolls?: number;
  canPrepareNextBatch?: boolean;
}): BatchRollDecision {
  const maxRolls = input.maxConsecutiveBatchRolls ?? DEFAULT_MAX_CONSECUTIVE_BATCH_ROLLS;
  if (input.consecutiveBatchRolls >= maxRolls) {
    return {
      kind: "halt_for_review",
      reason: `连续批续窗已达上限 ${maxRolls}，停止自动推进以免死循环。`,
    };
  }

  const prepared = input.nextPreparedExecutableWindow ?? null;
  if (prepared && prepared.startOrder > input.range.endOrder) {
    return {
      kind: "expand_range",
      reason: `当前窗 ${input.range.startOrder}-${input.range.endOrder} 已完成，下一可执行窗 ${prepared.startOrder}-${prepared.endOrder} 合同已就绪。`,
      nextRange: prepared,
    };
  }

  const unprepared = input.nextUnpreparedWindow ?? null;
  if (unprepared && unprepared.startOrder > input.range.endOrder) {
    if (input.canPrepareNextBatch === false) {
      return {
        kind: "halt_for_review",
        reason: `当前窗已完成，下一窗 ${unprepared.startOrder}-${unprepared.endOrder} 尚未细化，且未注入 prepareNextAutoExecutionBatch。`,
        nextRange: unprepared,
      };
    }
    return {
      kind: "reenter_structured_outline",
      reason: `当前窗 ${input.range.startOrder}-${input.range.endOrder} 已完成，下一窗 ${unprepared.startOrder}-${unprepared.endOrder} 需结构化大纲细化后进入执行。`,
      nextRange: unprepared,
    };
  }

  return {
    kind: "completed_scope",
    reason: `当前执行范围 ${input.range.startOrder}-${input.range.endOrder} 已完成，且无后续可续窗。`,
  };
}

export function buildExpandedAutoExecutionRange(input: {
  nextRange: BatchRollWindow;
  chapters: DirectorAutoExecutionChapterRef[];
}): DirectorAutoExecutionRange {
  const selected = input.chapters
    .filter((chapter) => chapter.order >= input.nextRange.startOrder && chapter.order <= input.nextRange.endOrder)
    .sort((left, right) => left.order - right.order);
  // Shrink endOrder to the last persisted chapter in the window so the downstream
  // scope runtime's findMissingChapterOrders never throws "缺少第 N 章" when the
  // decision was made from workspace-enriched readiness but DB rows lag behind
  // (workspace has the contract ready, listChapters hasn't persisted the row yet).
  // Without this, expand → runFromReady → resolveAutoExecutionRuntimeRangeAndState
  // throws and the auto-recovery path silently aborts instead of auto-resuming.
  const resolvedStartOrder = selected.length > 0 ? selected[0]!.order : input.nextRange.startOrder;
  const resolvedEndOrder = selected.length > 0 ? selected[selected.length - 1]!.order : input.nextRange.endOrder;
  return {
    startOrder: resolvedStartOrder,
    endOrder: resolvedEndOrder,
    totalChapterCount: Math.max(resolvedEndOrder - resolvedStartOrder + 1, selected.length),
    firstChapterId: selected[0]?.id ?? null,
  };
}

/**
 * Apply expand_range: rebuild state for the next prepared window, preserving skip/quality debt.
 */
export function applyExpandRangeBatchRoll(input: {
  previousState: DirectorAutoExecutionState;
  nextRange: BatchRollWindow;
  chapters: DirectorAutoExecutionChapterRef[];
}): {
  range: DirectorAutoExecutionRange;
  autoExecution: DirectorAutoExecutionState;
} {
  const range = buildExpandedAutoExecutionRange({
    nextRange: input.nextRange,
    chapters: input.chapters,
  });
  const autoExecution = buildDirectorAutoExecutionState({
    range,
    chapters: input.chapters,
    plan: {
      ...input.previousState,
      mode: "chapter_range",
      startOrder: range.startOrder,
      endOrder: range.endOrder,
    },
    scopeLabel: `第 ${range.startOrder}-${range.endOrder} 章`,
    volumeTitle: input.previousState.volumeTitle,
    preparedVolumeIds: input.previousState.preparedVolumeIds,
    pipelineJobId: null,
    pipelineStatus: "queued",
  });
  return {
    range,
    autoExecution: {
      ...autoExecution,
      pipelineJobId: null,
      pipelineStatus: "queued",
    },
  };
}

export type PrepareNextAutoExecutionBatchInput = {
  novelId: string;
  taskId: string;
  decision: BatchRollDecision;
  previousState: DirectorAutoExecutionState;
  previousRange: DirectorAutoExecutionRange;
};

export type PrepareNextAutoExecutionBatchResult = {
  range: DirectorAutoExecutionRange;
  autoExecution: DirectorAutoExecutionState;
};
