import type { DirectorCommandAcceptedResponse } from "@ai-novel/shared/types/directorRuntime";
import type { DirectorContinuationMode } from "@ai-novel/shared/types/novelDirector";
import type { UnifiedTaskDetail } from "@ai-novel/shared/types/task";

export function resolveWorkflowContinuationFeedback(
  task: UnifiedTaskDetail | DirectorCommandAcceptedResponse | null | undefined,
  options?: {
    mode?: DirectorContinuationMode;
    scopeLabel?: string | null;
  },
): {
  tone: "success" | "error";
  message: string;
} {
  const requestedScopeLabel = options?.scopeLabel?.trim();
  const taskScopeLabel = task && "executionScopeLabel" in task ? task.executionScopeLabel?.trim() : undefined;
  const scopeLabel = requestedScopeLabel || taskScopeLabel || "当前章节范围";

  if (task && "kind" in task && task.status === "failed") {
    return {
      tone: "error",
      message: task.failureSummary?.trim()
        || task.blockingReason?.trim()
        || task.lastError?.trim()
        || (options?.mode === "auto_execute_range"
          ? `继续自动执行${scopeLabel}失败。`
          : "继续自动导演失败。"),
    };
  }

  // skip_quality_repair 已废弃为质量旁路：服务端永不跳过质量债，仅按 range 续跑。
  // 旧客户端若仍传该 mode，toast 不得再暗示「已跳过质量建议」。
  const isRangeContinue = options?.mode === "auto_execute_range"
    || options?.mode === "skip_quality_repair";
  return {
    tone: "success",
    message: isRangeContinue
      ? `已继续自动执行${scopeLabel}。`
      : "自动导演已继续推进。",
  };
}

/**
 * 客户端续跑策略映射。
 * 禁止把质量检查点策略化映射为 skip_quality_repair（监管契约 / A7）。
 * skip 枚举仅兼容旧 API；UI 主路径不得发送，且服务端永不据此跳过质量债。
 */
export function resolveDirectorContinueMode(task: Pick<
  UnifiedTaskDetail,
  "checkpointType" | "currentItemKey" | "currentStage" | "pendingManualRecovery"
> | null | undefined): DirectorContinuationMode {
  if (task?.pendingManualRecovery) {
    return "resume";
  }
  // 质量相关检查点：resume 让服务端按真实 quality 债决策，禁止客户端 skip
  if (
    task?.checkpointType === "replan_required"
    || task?.currentItemKey === "quality_repair"
    || task?.currentStage?.includes("质量")
  ) {
    return "resume";
  }
  if (task?.checkpointType === "chapter_batch_ready") {
    return "auto_execute_range";
  }
  return "resume";
}
