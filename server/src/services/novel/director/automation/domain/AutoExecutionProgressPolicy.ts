export interface AutoExecutionCursor {
  nextChapterId?: string | null;
  nextChapterOrder?: number | null;
  remainingChapterCount?: number | null;
}

export interface AutoExecutionProgressGuardState {
  consecutiveNoProgress: number;
  shouldStop: boolean;
}

export function didAutoExecutionAdvance(
  before: AutoExecutionCursor,
  after: AutoExecutionCursor,
): boolean {
  return after.nextChapterId !== before.nextChapterId
    || after.nextChapterOrder !== before.nextChapterOrder
    || (after.remainingChapterCount ?? 0) < (before.remainingChapterCount ?? 0);
}

export function advanceAutoExecutionProgressGuard(input: {
  previous: AutoExecutionProgressGuardState;
  before: AutoExecutionCursor;
  after: AutoExecutionCursor;
  maxConsecutiveNoProgress: number;
}): AutoExecutionProgressGuardState {
  if (didAutoExecutionAdvance(input.before, input.after)) {
    return { consecutiveNoProgress: 0, shouldStop: false };
  }
  const consecutiveNoProgress = input.previous.consecutiveNoProgress + 1;
  return {
    consecutiveNoProgress,
    shouldStop: consecutiveNoProgress >= input.maxConsecutiveNoProgress,
  };
}
