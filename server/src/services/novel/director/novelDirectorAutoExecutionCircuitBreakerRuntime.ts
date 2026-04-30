import type {
  DirectorAutoExecutionState,
  DirectorCircuitBreakerState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import type { PipelineJobStatus } from "@ai-novel/shared/types/novel";
import {
  buildDirectorAutoExecutionPausedLabel,
  buildDirectorAutoExecutionPausedSummary,
  buildDirectorAutoExecutionScopeLabelFromState,
  type DirectorAutoExecutionRange,
} from "./novelDirectorAutoExecution";
import {
  syncAutoExecutionTaskState,
  type AutoExecutionCheckpointRuntimeDeps,
  type AutoExecutionResumeStage,
} from "./novelDirectorAutoExecutionCheckpointRuntime";
import {
  buildClosedDirectorCircuitBreakerState,
  isDirectorCircuitBreakerOpen,
  recordModelFailureSignal,
  recordPatchFailureSignal,
  recordUsageAnomalySignal,
  withCircuitBreakerState,
} from "./runtime/DirectorCircuitBreakerService";
import { directorAutomationLedgerEventService } from "./runtime/DirectorAutomationLedgerEventService";
import { directorUsageTelemetryQueryService } from "./runtime/DirectorUsageTelemetryQueryService";

interface CircuitBreakerWorkflowPort extends AutoExecutionCheckpointRuntimeDeps {
  workflowService: AutoExecutionCheckpointRuntimeDeps["workflowService"] & {
    markTaskFailed(taskId: string, message: string, patch?: {
      stage?: "quality_repair";
      itemKey?: string | null;
      itemLabel?: string;
      checkpointType?: "chapter_batch_ready" | "replan_required";
      checkpointSummary?: string | null;
      chapterId?: string | null;
      progress?: number;
    }): Promise<unknown>;
  };
}

export async function stopAutoExecutionForCircuitBreaker(
  deps: CircuitBreakerWorkflowPort,
  input: {
    taskId: string;
    novelId: string;
    request: DirectorConfirmRequest;
    range: DirectorAutoExecutionRange;
    autoExecution: DirectorAutoExecutionState;
    circuitBreaker: DirectorCircuitBreakerState;
    resumeStage?: AutoExecutionResumeStage;
  },
): Promise<void> {
  const autoExecution = withCircuitBreakerState(input.autoExecution, input.circuitBreaker);
  const scopeLabel = buildDirectorAutoExecutionScopeLabelFromState(autoExecution, input.range.totalChapterCount);
  const message = input.circuitBreaker.message?.trim()
    || `${scopeLabel}已暂停，等待处理后再继续。`;
  await directorAutomationLedgerEventService.recordCircuitBreakerOpened({
    taskId: input.taskId,
    novelId: input.novelId,
    state: input.circuitBreaker,
  }).catch(() => null);
  await deps.workflowService.markTaskFailed(input.taskId, message, {
    stage: "quality_repair",
    itemKey: "quality_repair",
    itemLabel: buildDirectorAutoExecutionPausedLabel(autoExecution),
    checkpointType: input.circuitBreaker.reason === "replan_loop" ? "replan_required" : "chapter_batch_ready",
    checkpointSummary: buildDirectorAutoExecutionPausedSummary({
      scopeLabel,
      remainingChapterCount: autoExecution.remainingChapterCount ?? 0,
      nextChapterOrder: autoExecution.nextChapterOrder ?? null,
      failureMessage: message,
    }),
    chapterId: autoExecution.nextChapterId ?? input.range.firstChapterId,
    progress: 0.98,
  });
  await syncAutoExecutionTaskState(deps, {
    taskId: input.taskId,
    novelId: input.novelId,
    request: input.request,
    range: input.range,
    autoExecution,
    isBackgroundRunning: false,
    resumeStage: input.resumeStage ?? "pipeline",
  });
}

export async function resolveUsageCircuitBreaker(input: {
  taskId: string;
  novelId: string;
  autoExecution: DirectorAutoExecutionState;
}): Promise<DirectorCircuitBreakerState | null> {
  const usage = await directorUsageTelemetryQueryService.getBookUsage({
    novelId: input.novelId,
    taskIds: [input.taskId],
  }).catch(() => null);
  const largestRecentUsage = usage?.recentUsage
    .slice()
    .sort((left, right) => right.totalTokens - left.totalTokens)[0] ?? null;
  if (!largestRecentUsage) {
    return null;
  }
  return recordUsageAnomalySignal({
    previous: input.autoExecution.circuitBreaker,
    usageRecordId: largestRecentUsage.id,
    totalTokens: largestRecentUsage.totalTokens,
    nodeKey: largestRecentUsage.nodeKey,
  });
}

export function buildFailureCircuitBreaker(input: {
  autoExecution: DirectorAutoExecutionState;
  jobStatus: PipelineJobStatus;
  message: string;
}): DirectorCircuitBreakerState {
  if (input.jobStatus === "cancelled") {
    return buildClosedDirectorCircuitBreakerState(input.autoExecution.circuitBreaker);
  }
  if (input.autoExecution.autoRepair) {
    return recordPatchFailureSignal({
      previous: input.autoExecution.circuitBreaker,
      chapterId: input.autoExecution.nextChapterId,
      chapterOrder: input.autoExecution.nextChapterOrder,
      message: input.message,
    });
  }
  return recordModelFailureSignal({
    previous: input.autoExecution.circuitBreaker,
    reason: input.jobStatus === "failed" ? "service_unavailable" : "model_unavailable",
    message: input.message,
    nodeKey: "chapter_execution_node",
  });
}

export { isDirectorCircuitBreakerOpen, withCircuitBreakerState };
