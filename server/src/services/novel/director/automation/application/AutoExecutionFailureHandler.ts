import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import { isFullBookAutopilotRunMode } from "@ai-novel/shared/types/novelDirector";
import { parsePipelinePayload } from "../../../pipelineJobState";
import { directorAutomationLedgerEventService } from "../../runtime/DirectorAutomationLedgerEventService";
import {
  buildDirectorQualityLoopBudgetWindow,
  buildDirectorQualityLoopIssueSignature,
  findDirectorQualityLoopBudgetEntry,
  recordDirectorQualityLoopBudgetAttempt,
  resolveDirectorQualityLoopBudgetNextAction,
} from "../../runtime/DirectorQualityLoopBudgetLedgerService";
import {
  buildDirectorAutoExecutionDeferredQualityState,
  buildDirectorAutoExecutionPausedLabel,
  buildDirectorAutoExecutionPausedSummary,
  buildDirectorAutoExecutionScopeLabelFromState,
  type DirectorAutoExecutionChapterRef,
  type DirectorAutoExecutionRange,
} from "../novelDirectorAutoExecution";
import {
  buildFailureCircuitBreaker,
  isDirectorCircuitBreakerOpen,
  stopAutoExecutionForCircuitBreaker,
  withCircuitBreakerState,
} from "../novelDirectorAutoExecutionCircuitBreakerRuntime";
import { syncAutoExecutionTaskState } from "../novelDirectorAutoExecutionCheckpointRuntime";
import { isSkippableAutoExecutionReviewFailure } from "../novelDirectorAutoExecutionFailure";
import { resolveAutoExecutionRuntimeRangeAndState } from "../novelDirectorAutoExecutionRuntimePreparation";
import type {
  NovelDirectorAutoExecutionRuntimeDeps,
  PipelineJobSnapshot,
} from "../novelDirectorAutoExecutionRuntimePorts";
import {
  advanceAutoExecutionProgressGuard,
  type AutoExecutionProgressGuardState,
} from "../domain/AutoExecutionProgressPolicy";
import { isContinuableAutoExecutionQualityDebt } from "../domain/AutoExecutionQualityDebtPolicy";
import { shouldStopAutoExecutionForQualityAction } from "../domain/AutoExecutionStopPolicy";
import { stopAutoExecutionForNoProgress } from "../projections/AutoExecutionTaskProjector";

export type AutoExecutionFailureOutcome =
  | {
    kind: "continue";
    range: DirectorAutoExecutionRange;
    autoExecution: DirectorAutoExecutionState;
    progressGuard: AutoExecutionProgressGuardState;
  }
  | { kind: "stop" };

export async function handleAutoExecutionFailure(input: {
  deps: NovelDirectorAutoExecutionRuntimeDeps;
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  range: DirectorAutoExecutionRange;
  autoExecution: DirectorAutoExecutionState;
  pipelineJobId: string;
  job: NonNullable<PipelineJobSnapshot>;
  allowLazyChapterPlanning: boolean;
  progressGuard: AutoExecutionProgressGuardState;
  maxConsecutiveNoProgress: number;
  resolveQualityIssueChapter: () => Promise<DirectorAutoExecutionChapterRef | null>;
}): Promise<AutoExecutionFailureOutcome> {
  const { deps, taskId, novelId, request, job } = input;
  let { range, autoExecution, progressGuard } = input;
  const scopeLabel = buildDirectorAutoExecutionScopeLabelFromState(
    autoExecution,
    range.totalChapterCount,
  );
  const failureMessage = job.error?.trim()
    || (job.status === "cancelled"
      ? `${scopeLabel}自动执行已取消。`
      : `${scopeLabel}自动执行未能全部通过质量要求。`);

  if (
    isFullBookAutopilotRunMode(request.runMode)
    && isSkippableAutoExecutionReviewFailure(failureMessage)
    && deps.resolveStateProposals
  ) {
    const resolution = await deps.resolveStateProposals({
      novelId,
      taskId,
      chapterId: autoExecution.nextChapterId ?? range.firstChapterId,
      chapterOrder: autoExecution.nextChapterOrder ?? null,
      runMode: request.runMode,
      provider: request.provider,
      model: request.model,
      temperature: request.temperature,
    });
    if (resolution.processed) {
      if (resolution.decision === "auto_replan_window" && deps.replanNovel) {
        await deps.replanNovel(novelId, {
          chapterId: autoExecution.nextChapterId ?? undefined,
          triggerType: "state_proposal_resolution",
          reason: resolution.reason ?? failureMessage,
          sourceIssueIds: resolution.proposalIds,
          windowSize: Math.max(1, resolution.affectedChapterWindow?.chapterOrders?.length ?? 1),
          provider: request.provider,
          model: request.model,
          temperature: request.temperature,
        });
      }
      ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(deps, {
        novelId,
        existingState: {
          ...autoExecution,
          pipelineJobId: null,
          pipelineStatus: null,
        },
        pipelineJobId: null,
        pipelineStatus: "queued",
        allowLazyChapterPlanning: input.allowLazyChapterPlanning,
      }));
      await syncAutoExecutionTaskState(deps, {
        taskId,
        novelId,
        request,
        range,
        autoExecution,
        isBackgroundRunning: true,
        resumeStage: "pipeline",
      });
      return { kind: "continue", range, autoExecution, progressGuard };
    }
  }

  let budgetedAutoExecution = autoExecution;
  let qualityBudgetEntry: ReturnType<typeof recordDirectorQualityLoopBudgetAttempt>["entry"] | null = null;
  let qualityBudgetNextAction: ReturnType<typeof recordDirectorQualityLoopBudgetAttempt>["nextAction"] | null = null;
  if (job.status !== "cancelled" && autoExecution.autoRepair) {
    const pipelinePayload = parsePipelinePayload(job.payload);
    const affectedChapterWindow = buildDirectorQualityLoopBudgetWindow({
      autoExecution,
      chapterId: autoExecution.nextChapterId,
      chapterOrder: autoExecution.nextChapterOrder,
    });
    const issueSignature = buildDirectorQualityLoopIssueSignature({
      reason: failureMessage,
      noticeCode: job.noticeCode,
      repairMode: pipelinePayload.repairMode,
    });
    const existingBudgetEntry = findDirectorQualityLoopBudgetEntry({
      state: autoExecution,
      novelId,
      taskId,
      issueSignature,
      affectedChapterWindow,
    });
    const plannedBudgetAction = resolveDirectorQualityLoopBudgetNextAction(existingBudgetEntry);
    const budgetAttemptAction = plannedBudgetAction === "auto_rewrite_chapter"
      ? "chapter_rewrite"
      : plannedBudgetAction === "auto_replan_window"
        ? "window_replan"
        : plannedBudgetAction === "defer_and_continue"
          ? "defer_and_continue"
          : "patch_repair";
    const budgetResult = recordDirectorQualityLoopBudgetAttempt({
      state: autoExecution,
      novelId,
      taskId,
      issueSignature,
      affectedChapterWindow,
      action: budgetAttemptAction,
      reason: failureMessage,
      chapterId: autoExecution.nextChapterId,
      chapterOrder: autoExecution.nextChapterOrder,
    });
    budgetedAutoExecution = budgetResult.state;
    qualityBudgetEntry = budgetResult.entry;
    qualityBudgetNextAction = budgetResult.nextAction;
  }
  const failureCircuitBreaker = buildFailureCircuitBreaker({
    autoExecution: budgetedAutoExecution,
    jobStatus: job.status,
    message: failureMessage,
  });
  const failedAutoExecution = withCircuitBreakerState({
    ...budgetedAutoExecution,
    pipelineJobId: input.pipelineJobId,
    pipelineStatus: job.status,
  }, failureCircuitBreaker);
  if (autoExecution.autoRepair && job.status !== "cancelled") {
    const ledger = deps.automationLedgerEventService ?? directorAutomationLedgerEventService;
    await ledger.recordRepairTicketCreated({
      taskId,
      novelId,
      chapterId: autoExecution.nextChapterId ?? null,
      summary: failureMessage,
      failureCount: failureCircuitBreaker.patchFailureCount ?? failureCircuitBreaker.failureCount ?? 1,
      metadata: {
        pipelineJobId: input.pipelineJobId,
        pipelineStatus: job.status,
        chapterOrder: autoExecution.nextChapterOrder ?? null,
        qualityBudgetEntry,
        qualityBudgetNextAction,
      },
    }).catch(() => null);
  }

  const qualityAction = failureCircuitBreaker.reason === "replan_loop"
    ? "stop_for_replan"
    : qualityBudgetNextAction === "defer_and_continue"
      ? "continue_with_warning"
      : "local_patch_plan";
  const shouldEvaluateQualityDebt = (
    isDirectorCircuitBreakerOpen(failureCircuitBreaker)
    || qualityBudgetNextAction === "defer_and_continue"
  ) && isFullBookAutopilotRunMode(request.runMode)
    && (failureCircuitBreaker.reason === "auto_repair_exhausted"
      || failureCircuitBreaker.reason === "replan_loop");
  const qualityIssueChapter = shouldEvaluateQualityDebt
    ? await input.resolveQualityIssueChapter()
    : null;
  const canContinueWithQualityDebt = isContinuableAutoExecutionQualityDebt({
    action: qualityAction,
    hasUsableChapterContent: Boolean(qualityIssueChapter?.content?.trim()),
  }) && !shouldStopAutoExecutionForQualityAction(qualityAction);

  if (
    shouldEvaluateQualityDebt && canContinueWithQualityDebt
  ) {
    const deferredState = buildDirectorAutoExecutionDeferredQualityState({
      state: withCircuitBreakerState(failedAutoExecution, null),
      reason: failureMessage,
      source: failureCircuitBreaker.reason === "replan_loop" ? "replan_loop" : "repair_failure",
      chapter: qualityIssueChapter,
    });
    const ledger = deps.automationLedgerEventService ?? directorAutomationLedgerEventService;
    await ledger.recordEvent({
      type: "continue_with_risk",
      idempotencyKey: [
        taskId,
        novelId,
        autoExecution.nextChapterId ?? "unknown",
        autoExecution.nextChapterOrder ?? "unknown",
        failureCircuitBreaker.reason,
        failureCircuitBreaker.failureCount ?? "failure",
      ].join(":"),
      taskId,
      novelId,
      nodeKey: failureCircuitBreaker.nodeKey ?? "chapter_repair_node",
      summary: "全书自动成书已暂存本章质量问题，并继续推进后续章节。",
      affectedScope: autoExecution.nextChapterId
        ? `chapter:${autoExecution.nextChapterId}`
        : (typeof autoExecution.nextChapterOrder === "number"
          ? `chapter_order:${autoExecution.nextChapterOrder}`
          : null),
      severity: "medium",
      metadata: {
        decision: "defer_and_continue",
        circuitBreaker: failureCircuitBreaker,
        failureMessage,
        chapterOrder: autoExecution.nextChapterOrder ?? null,
        qualityBudgetEntry,
        qualityBudgetNextAction,
      },
    }).catch(() => null);
    const progressCursorBefore = {
      nextChapterId: autoExecution.nextChapterId ?? null,
      nextChapterOrder: autoExecution.nextChapterOrder ?? null,
      remainingChapterCount: autoExecution.remainingChapterCount ?? 0,
    };
    ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(deps, {
      novelId,
      existingState: deferredState,
      pipelineJobId: null,
      pipelineStatus: "queued",
      allowLazyChapterPlanning: input.allowLazyChapterPlanning,
    }));
    progressGuard = advanceAutoExecutionProgressGuard({
      previous: progressGuard,
      before: progressCursorBefore,
      after: autoExecution,
      maxConsecutiveNoProgress: input.maxConsecutiveNoProgress,
    });
    if (progressGuard.shouldStop) {
      await stopAutoExecutionForNoProgress(deps, {
        taskId,
        novelId,
        request,
        range,
        autoExecution,
        maxConsecutiveNoProgress: input.maxConsecutiveNoProgress,
        source: "defer_and_continue",
      });
      return { kind: "stop" };
    }
    await syncAutoExecutionTaskState(deps, {
      taskId,
      novelId,
      request,
      range,
      autoExecution,
      isBackgroundRunning: true,
      resumeStage: "pipeline",
    });
    return { kind: "continue", range, autoExecution, progressGuard };
  }

  if (isDirectorCircuitBreakerOpen(failureCircuitBreaker)) {
    await stopAutoExecutionForCircuitBreaker(deps, {
      taskId,
      novelId,
      request,
      range,
      autoExecution: failedAutoExecution,
      circuitBreaker: failureCircuitBreaker,
      resumeStage: "pipeline",
    });
    return { kind: "stop" };
  }
  await deps.workflowService.markTaskFailed(taskId, failureMessage, {
    stage: "quality_repair",
    itemKey: "quality_repair",
    itemLabel: buildDirectorAutoExecutionPausedLabel(autoExecution),
    checkpointType: "chapter_batch_ready",
    checkpointSummary: buildDirectorAutoExecutionPausedSummary({
      scopeLabel,
      remainingChapterCount: autoExecution.remainingChapterCount ?? 0,
      nextChapterOrder: autoExecution.nextChapterOrder ?? null,
      failureMessage,
    }),
    chapterId: autoExecution.nextChapterId ?? range.firstChapterId,
    progress: 0.98,
  });
  await syncAutoExecutionTaskState(deps, {
    taskId,
    novelId,
    request,
    range,
    autoExecution: failedAutoExecution,
    isBackgroundRunning: false,
    resumeStage: "pipeline",
  });
  return { kind: "stop" };
}
