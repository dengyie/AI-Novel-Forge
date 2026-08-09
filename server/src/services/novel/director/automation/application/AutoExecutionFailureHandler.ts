import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import { isFullBookAutopilotRunMode } from "@ai-novel/shared/types/novelDirector";
import { parsePipelinePayload } from "../../../pipelineJobState";
import { parseContractIssueDescriptor } from "@ai-novel/shared/types/chapterTaskSheetQuality";
import { directorAutomationLedgerEventService } from "../../runtime/DirectorAutomationLedgerEventService";
import {
  buildDirectorQualityLoopBudgetWindow,
  buildDirectorQualityLoopIssueSignature,
  buildDirectorQualityLoopIssueSignatureFromIssues,
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
  buildUnavailableModelCircuitBreaker,
  isDirectorCircuitBreakerOpen,
  runFullBookAutopilotReplanNotice,
  stopAutoExecutionForCircuitBreaker,
  withCircuitBreakerState,
} from "../novelDirectorAutoExecutionCircuitBreakerRuntime";
import { syncAutoExecutionTaskState } from "../novelDirectorAutoExecutionCheckpointRuntime";
import {
  isContractReplanWindowFailure,
  isSkippableAutoExecutionReviewFailure,
  isTransientModelFailure,
  MAX_TRANSIENT_MODEL_FALLBACK,
  mergeTransientModelAttemptedTargets,
  resolveFailedPipelineModelTarget,
  resolveTransientFallbackModel,
} from "../novelDirectorAutoExecutionFailure";
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
import type { AutoExecutionOwnershipFence } from "../domain/AutoExecutionOwnershipFence";

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
  ownershipFence?: AutoExecutionOwnershipFence;
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
  // 方案 C（Phase 3）：失败实体携带的结构化描述符（recommendedHandling + issue.targets）。
  // 有则用稳定结构构造预算签名（同结构复现 ⇒ 同签名 ⇒ 阶梯单调升级）；无则回退消息旧签名。
  const parsedContractIssue = parseContractIssueDescriptor(failureMessage);
  const assertOwnership = async (): Promise<void> => {
    await input.ownershipFence?.assertActive();
  };

  // 章节执行合同门禁判 replan_window（职责过载）：结构性难题需整窗重排，本地再生成修不好。
  // 复用 runFullBookAutopilotReplanNotice（内含 window_replan 预算记账 + 重排环熔断 + replanNovel）。
  // 预算耗尽 / 重排环熔断（decision=defer_and_continue）时回退到现有 markTaskFailed 行为——重排循环需人工判断。
  if (
    autoExecution.autoRepair
    && isFullBookAutopilotRunMode(request.runMode)
    // Phase 3：marker 兼容网关 + 结构化 recommendedHandling 双通道（在途旧消息无信封，走 marker）。
    && (isContractReplanWindowFailure(failureMessage) || parsedContractIssue?.recommendedHandling === "replan_window")
    && deps.replanNovel
  ) {
    const replanResult = await runFullBookAutopilotReplanNotice({
      deps,
      taskId,
      novelId,
      request,
      range,
      autoExecution,
      checkpointState: autoExecution,
      noticeSummary: failureMessage,
      triggerType: "contract_replan_window",
      ownershipFence: input.ownershipFence,
    });
    if (replanResult.stopped) {
      return { kind: "stop" };
    }
    if (replanResult.decision === "auto_replan_window") {
      ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(deps, {
        novelId,
        existingState: {
          ...(replanResult.autoExecution ?? autoExecution),
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
        ownershipFence: input.ownershipFence,
      });
      return { kind: "continue", range, autoExecution, progressGuard };
    }
    if (replanResult.decision === "defer_and_continue") {
      // 重排预算耗尽 / 重排环熔断：保守停止，需人工判断。runtime 已记账，不发误导性
      // continue_with_risk，直接落 markTaskFailed，与既有终态停等行为一致。
      const stopAutoExecution = withCircuitBreakerState({
        ...(replanResult.autoExecution ?? autoExecution),
        pipelineJobId: input.pipelineJobId,
        pipelineStatus: job.status,
      }, replanResult.circuitBreaker);
      const stopMessage = `${scopeLabel}章节执行合同重排预算已耗尽（重排环熔断），自动成书暂停，等待人工判断后继续。`;
      await assertOwnership();
      await deps.workflowService.markTaskFailed(taskId, stopMessage, {
        stage: "quality_repair",
        itemKey: "quality_repair",
        itemLabel: buildDirectorAutoExecutionPausedLabel(stopAutoExecution),
        checkpointType: "replan_required",
        checkpointSummary: buildDirectorAutoExecutionPausedSummary({
          scopeLabel,
          remainingChapterCount: stopAutoExecution.remainingChapterCount ?? 0,
          nextChapterOrder: stopAutoExecution.nextChapterOrder ?? null,
          failureMessage: stopMessage,
        }),
        chapterId: stopAutoExecution.nextChapterId ?? range.firstChapterId,
        progress: 0.98,
      });
      await syncAutoExecutionTaskState(deps, {
        taskId,
        novelId,
        request,
        range,
        autoExecution: stopAutoExecution,
        isBackgroundRunning: false,
        resumeStage: "pipeline",
        ownershipFence: input.ownershipFence,
      });
      return { kind: "stop" };
    }
  }

  if (
    isFullBookAutopilotRunMode(request.runMode)
    && isSkippableAutoExecutionReviewFailure(failureMessage)
    && deps.resolveStateProposals
  ) {
    await assertOwnership();
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
        await assertOwnership();
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
        ownershipFence: input.ownershipFence,
      });
      return { kind: "continue", range, autoExecution, progressGuard };
    }
  }

  // 方案 D（P1-4）：瞬态模型/服务故障独立 fallback 重投递。
  // transport 类失败（timeout/503/429/reset，非质量门禁、非用户取消）先走独立预算重投该批次，
  // 不立即计入质量预算阶梯（不污染内容修复阶梯），也不累计 patch/model 熔断信号——瞬时抖动给足自愈窗口。
  // 只有目录中存在尚未失败的新候选且预算未耗尽时才换模重投；候选耗尽、执行事实缺失
  // 或预算耗尽都会清掉旧 override，并进入独立模型/服务熔断检查点。计数持久化在
  // autoExecution 状态（transientModelFallbackCount），跨进程 / 服务重启连续累计。
  if (
    autoExecution.autoRepair
    && isFullBookAutopilotRunMode(request.runMode)
    && isTransientModelFailure(failureMessage, job.status)
  ) {
    const failedPayload = parsePipelinePayload(job.payload);
    const failedTarget = resolveFailedPipelineModelTarget({
      payloadProvider: failedPayload.provider,
      payloadModel: failedPayload.model,
      activeOverride: autoExecution.transientModelOverride,
      requestProvider: request.provider,
      requestModel: request.model,
    });
    // Legacy states may have an override but no attempted-target ledger. Seed the original
    // request target before the failed override so a two-model provider cannot cycle back.
    const legacyOriginalTarget = autoExecution.transientModelOverride
      ? resolveFailedPipelineModelTarget({
        requestProvider: request.provider,
        requestModel: request.model,
      })
      : null;
    const attemptedTargets = mergeTransientModelAttemptedTargets(
      autoExecution.transientModelAttemptedTargets,
      legacyOriginalTarget,
      failedTarget,
    );
    const transientFallbackModel = failedTarget
      && (autoExecution.transientModelFallbackCount ?? 0) < MAX_TRANSIENT_MODEL_FALLBACK
      ? await resolveTransientFallbackModel({
        provider: failedTarget.provider,
        currentModel: failedTarget.model,
        attemptedTargets,
      })
      : null;
    if (transientFallbackModel) {
      autoExecution = {
        ...autoExecution,
        transientModelFallbackCount: (autoExecution.transientModelFallbackCount ?? 0) + 1,
        transientModelOverride: transientFallbackModel,
        transientModelAttemptedTargets: attemptedTargets,
        pipelineJobId: null,
        pipelineStatus: null,
      };
      ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(deps, {
        novelId,
        existingState: autoExecution,
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
        ownershipFence: input.ownershipFence,
      });
      return { kind: "continue", range, autoExecution, progressGuard };
    }
    // Catalog exhaustion, catalog failure, missing execution facts, or exhausted failover
    // budget is infrastructure state, not chapter quality debt. Persist the failed targets,
    // clear the unusable override, and stop at a switch-model recovery checkpoint.
    const unavailableAutoExecution = {
      ...autoExecution,
      transientModelOverride: null,
      transientModelAttemptedTargets: attemptedTargets,
      pipelineJobId: input.pipelineJobId,
      pipelineStatus: job.status,
    };
    const unavailableCircuitBreaker = buildUnavailableModelCircuitBreaker({
      autoExecution: unavailableAutoExecution,
      jobStatus: job.status,
      message: failureMessage,
    });
    await stopAutoExecutionForCircuitBreaker(deps, {
      taskId,
      novelId,
      request,
      range,
      autoExecution: unavailableAutoExecution,
      circuitBreaker: unavailableCircuitBreaker,
      resumeStage: "pipeline",
      ownershipFence: input.ownershipFence,
    });
    return { kind: "stop" };
  }

  let budgetedAutoExecution = autoExecution;
  let qualityBudgetEntry: ReturnType<typeof recordDirectorQualityLoopBudgetAttempt>["entry"] | null = null;
  let qualityBudgetNextAction: ReturnType<typeof recordDirectorQualityLoopBudgetAttempt>["nextAction"] | null = null;
  // 方案 C（Phase 2）：本次实际记账的修复动作（patch_repair / chapter_rewrite / 其他）。
  // 用于决定是否为"可重进管线的活动作"——依据的是当轮真正采取的 action，而非记账后的下一档。
  let executedBudgetAction: "patch_repair" | "chapter_rewrite" | null = null;
  if (job.status !== "cancelled" && autoExecution.autoRepair) {
    const pipelinePayload = parsePipelinePayload(job.payload);
    const affectedChapterWindow = buildDirectorQualityLoopBudgetWindow({
      autoExecution,
      chapterId: autoExecution.nextChapterId,
      chapterOrder: autoExecution.nextChapterOrder,
    });
    // Phase 3：有结构化信封 → 稳定签名（recommendedHandling + issue.targets，逐章波动时不变）；
    // 无信封（在途旧消息/网络错误）→ 回退 reason 版签名。
    const issueSignature = parsedContractIssue
      ? buildDirectorQualityLoopIssueSignatureFromIssues({
        recommendedHandling: parsedContractIssue.recommendedHandling,
        issueTargets: parsedContractIssue.issueTargets,
        noticeCode: job.noticeCode,
        repairMode: pipelinePayload.repairMode,
      })
      : buildDirectorQualityLoopIssueSignature({
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
    if (budgetAttemptAction === "patch_repair" || budgetAttemptAction === "chapter_rewrite") {
      executedBudgetAction = budgetAttemptAction;
    }
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
    await assertOwnership();
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
        contractIssueDescriptor: parsedContractIssue,
      },
    }).catch(() => null);
  }

  // Phase 2（方案 C）：当本轮回环预算决策为真正可重进管线的修复动作（patch_repair / chapter_rewrite）
  // 时，让修复成为可执行动作（而不仅是记账）。此处复用现有「continue → 执行环重放该批次」路径，
  // 不新写 stage 死代码：clone `budgetedAutoExecution`（已含本轮的 qualityLoopLedger + 熔断状态），
  // 置为 queued 续跑。若同一签名再次失败，账本计数已 +1，下一次失败会升级到更高 tier
  // （patch≥2 → rewrite → replan → defer），最终落在保守停等，重放次数有界。
  if (
    autoExecution.autoRepair
    && !isDirectorCircuitBreakerOpen(failureCircuitBreaker)
    && executedBudgetAction !== null
  ) {
    await assertOwnership();
    ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(deps, {
      novelId,
      existingState: {
        ...budgetedAutoExecution,
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
      ownershipFence: input.ownershipFence,
    });
    return { kind: "continue", range, autoExecution, progressGuard };
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
    await assertOwnership();
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
        ownershipFence: input.ownershipFence,
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
      ownershipFence: input.ownershipFence,
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
      ownershipFence: input.ownershipFence,
    });
    return { kind: "stop" };
  }
  await assertOwnership();
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
    ownershipFence: input.ownershipFence,
  });
  return { kind: "stop" };
}
