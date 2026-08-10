import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import { syncAutoExecutionTaskState } from "../novelDirectorAutoExecutionCheckpointRuntime";
import type { DirectorAutoExecutionRange } from "../novelDirectorAutoExecution";
import type { NovelDirectorAutoExecutionRuntimeDeps } from "../novelDirectorAutoExecutionRuntimePorts";
import type { AutoExecutionOwnershipFence } from "../domain/AutoExecutionOwnershipFence";

export async function stopAutoExecutionForNoProgress(
  deps: NovelDirectorAutoExecutionRuntimeDeps,
  input: {
    taskId: string;
    novelId: string;
    request: DirectorConfirmRequest;
    range: DirectorAutoExecutionRange;
    autoExecution: DirectorAutoExecutionState;
    maxConsecutiveNoProgress: number;
    source: "no-generatable defer" | "defer_and_continue";
    ownershipFence?: AutoExecutionOwnershipFence;
  },
): Promise<void> {
  await input.ownershipFence?.assertActive();
  const count = input.maxConsecutiveNoProgress;
  await deps.workflowService.markTaskFailed(
    input.taskId,
    `连续 ${count} 次暂存质量问题后章节游标仍未推进，自动执行已停止。`,
    {
      stage: "chapter_execution",
      itemKey: "auto_execution_no_progress",
      itemLabel: "章节游标未推进",
      checkpointType: "chapter_batch_ready",
      checkpointSummary: `连续 ${count} 次 ${input.source} 后 nextChapter 与 remainingChapterCount 均未变化，属于运行时无推进故障。`,
      chapterId: input.autoExecution.nextChapterId ?? input.range.firstChapterId,
      progress: 0.98,
    },
  );
  await syncAutoExecutionTaskState(deps, {
    taskId: input.taskId,
    novelId: input.novelId,
    request: input.request,
    range: input.range,
    autoExecution: input.autoExecution,
    isBackgroundRunning: false,
    resumeStage: "pipeline",
    ownershipFence: input.ownershipFence,
  });
}

export async function schedulePendingReviewAutoPromotionIfEnabled(
  deps: Pick<
    NovelDirectorAutoExecutionRuntimeDeps,
    "isPendingReviewAutoPromotionEnabled" | "autoPromotePendingReviewProposals"
  >,
  input: {
    novelId: string;
    taskId: string;
    ownershipFence?: AutoExecutionOwnershipFence;
  },
): Promise<void> {
  if (!deps.isPendingReviewAutoPromotionEnabled || !deps.autoPromotePendingReviewProposals) {
    return;
  }
  const enabled = await deps.isPendingReviewAutoPromotionEnabled();
  if (!enabled) {
    return;
  }
  await input.ownershipFence?.assertActive();
  await deps.autoPromotePendingReviewProposals({
    ...input,
    beforeCommit: async () => {
      await input.ownershipFence?.assertActive();
    },
  });
}
