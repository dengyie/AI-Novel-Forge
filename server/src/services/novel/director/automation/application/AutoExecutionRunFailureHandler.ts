import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import {
  syncAutoExecutionTaskState,
  type AutoExecutionResumeStage,
} from "../novelDirectorAutoExecutionCheckpointRuntime";
import type { DirectorAutoExecutionRange } from "../novelDirectorAutoExecution";
import type { NovelDirectorAutoExecutionRuntimeDeps } from "../novelDirectorAutoExecutionRuntimePorts";
import {
  AutoExecutionRunFailureError,
  isAutoExecutionOwnershipLost,
  isAutoExecutionRunFailure,
  type AutoExecutionOwnershipFence,
} from "../domain/AutoExecutionOwnershipFence";

export async function handleAutoExecutionRunFailure(input: {
  error: unknown;
  deps: NovelDirectorAutoExecutionRuntimeDeps;
  ownershipFence: AutoExecutionOwnershipFence;
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  resumeStage?: AutoExecutionResumeStage;
  cleanupState?: {
    range: DirectorAutoExecutionRange;
    autoExecution: DirectorAutoExecutionState;
  };
}): Promise<void> {
  if (isAutoExecutionRunFailure(input.error)) {
    throw input.error;
  }
  if (isAutoExecutionOwnershipLost(input.error)) {
    return;
  }

  let cleanupError: unknown;
  if (input.cleanupState) {
    try {
      await syncAutoExecutionTaskState(input.deps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range: input.cleanupState.range,
        autoExecution: {
          ...input.cleanupState.autoExecution,
          pipelineJobId: null,
          pipelineStatus: null,
        },
        isBackgroundRunning: false,
        resumeStage: input.resumeStage,
        ownershipFence: input.ownershipFence,
      });
    } catch (caught) {
      cleanupError = caught;
    }
  }

  try {
    await input.deps.workflowService.markTaskFailed(
      input.taskId,
      input.error instanceof Error ? input.error.message : "自动执行基础设施失败。",
      {
        stage: "chapter_execution",
        itemKey: "auto_execution_failure",
        itemLabel: "自动执行失败，等待重试或恢复",
      },
    );
  } catch (projectionError) {
    throw new AutoExecutionRunFailureError(input.error, projectionError);
  }
  throw new AutoExecutionRunFailureError(input.error, cleanupError);
}
