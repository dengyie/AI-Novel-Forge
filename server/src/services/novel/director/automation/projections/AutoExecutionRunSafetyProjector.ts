import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import type { DirectorAutoExecutionRange } from "../novelDirectorAutoExecution";
import { syncAutoExecutionTaskState } from "../novelDirectorAutoExecutionCheckpointRuntime";
import type { NovelDirectorAutoExecutionRuntimeDeps } from "../novelDirectorAutoExecutionRuntimePorts";
import type { AutoExecutionOwnershipFence } from "../domain/AutoExecutionOwnershipFence";

export async function stopAutoExecutionForIterationCap(input: {
  deps: NovelDirectorAutoExecutionRuntimeDeps;
  ownershipFence: AutoExecutionOwnershipFence;
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  range: DirectorAutoExecutionRange;
  autoExecution: DirectorAutoExecutionState;
  maxIterations: number;
}): Promise<void> {
  await input.ownershipFence.assertActive();
  await input.deps.workflowService.markTaskFailed(
    input.taskId,
    `自动执行循环已超过 ${input.maxIterations} 次迭代上限，已停止以防止死循环。`,
    {
      stage: "chapter_execution",
      itemKey: "batch_roll_iteration_cap",
      itemLabel: "自动执行循环超限",
      checkpointType: "chapter_batch_ready",
      checkpointSummary: `连续迭代超过 ${input.maxIterations} 次仍未推进，可能存在 readiness 与实际章节数据不一致或决策函数未执行 cap。`,
      chapterId: input.autoExecution.nextChapterId ?? input.range.firstChapterId,
      progress: 0.93,
    },
  );
  await syncAutoExecutionTaskState(input.deps, {
    taskId: input.taskId,
    novelId: input.novelId,
    request: input.request,
    range: input.range,
    autoExecution: {
      ...input.autoExecution,
      pipelineJobId: null,
      pipelineStatus: null,
    },
    isBackgroundRunning: false,
    resumeStage: "pipeline",
    ownershipFence: input.ownershipFence,
  });
}
