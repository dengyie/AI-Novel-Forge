import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import { isFullBookAutopilotRunMode } from "@ai-novel/shared/types/novelDirector";
import {
  buildDirectorAutoExecutionScopeLabelFromState,
  buildDirectorAutoExecutionDeferredQualityState,
  isDirectorAutoExecutionPipelineSkipEligibleChapter,
  normalizeConsecutiveBatchRolls,
  resolveDirectorAutoExecutionWorkflowState,
} from "../novelDirectorAutoExecution";
import {
  recordCompletedCheckpoint,
  recordQualityRepairCheckpoint,
  resolveQualityRepairNoticeAction,
  syncAutoExecutionTaskState,
  type AutoExecutionResumeStage,
} from "../novelDirectorAutoExecutionCheckpointRuntime";
import {
  isDirectorCircuitBreakerOpen,
  resolveUsageCircuitBreaker,
  stopAutoExecutionForCircuitBreaker,
  withCircuitBreakerState,
} from "../novelDirectorAutoExecutionCircuitBreakerRuntime";
import {
  isNoChaptersToGenerateError,
  shouldClearAutoExecutionCheckpoint,
} from "../novelDirectorAutoExecutionRuntimeUtils";
import { prepareRequestedAutoExecution as prepareRequestedAutoExecutionState, resolveAutoExecutionRuntimeRangeAndState, shouldStopAutoExecution } from "../novelDirectorAutoExecutionRuntimePreparation";
import type { NovelDirectorAutoExecutionRuntimeDeps, PipelineJobSnapshot } from "../novelDirectorAutoExecutionRuntimePorts";
import {
  advanceAutoExecutionProgressGuard,
  type AutoExecutionProgressGuardState,
} from "../domain/AutoExecutionProgressPolicy";
import {
  AutoExecutionOwnershipFence,
  AutoExecutionRunFailureError,
  isAutoExecutionOwnershipLost,
  isAutoExecutionRunFailure,
} from "../domain/AutoExecutionOwnershipFence";
import {
  schedulePendingReviewAutoPromotionIfEnabled,
  stopAutoExecutionForNoProgress,
} from "../projections/AutoExecutionTaskProjector";
import { AutoExecutionBatchRollCoordinator } from "./AutoExecutionBatchRollCoordinator";
import { handleAutoExecutionFailure } from "./AutoExecutionFailureHandler";
import {
  resolvePipelineJobForExecution,
  resolveOwnedActiveRangePipeline,
  resolveQualityIssueChapter,
  resolveStuckNoGeneratableChapter,
} from "./AutoExecutionChapterResolver";
import { startAutoExecutionPipelineJob } from "./AutoExecutionPipelineJobStarter";
import { stopAutoExecutionForIterationCap } from "../projections/AutoExecutionRunSafetyProjector";

export { schedulePendingReviewAutoPromotionIfEnabled } from "../projections/AutoExecutionTaskProjector";
export class AutoExecutionRangeRunner {
  constructor(private readonly deps: NovelDirectorAutoExecutionRuntimeDeps) {}

  async prepareRequestedAutoExecution(
    input: Parameters<typeof prepareRequestedAutoExecutionState>[1],
  ) {
    return prepareRequestedAutoExecutionState(this.deps, input);
  }

  async runFromReady(input: {
    taskId: string;
    novelId: string;
    request: DirectorConfirmRequest;
    existingPipelineJobId?: string | null;
    existingState?: DirectorAutoExecutionState | null;
    resumeCheckpointType?: "chapter_batch_ready" | "chapter_batch_ready" | "replan_required" | null;
    resumeStage?: AutoExecutionResumeStage;
    previousFailureMessage?: string | null;
    allowSkipReviewBlockedChapter?: boolean;
    approveAutoExecutionScope?: boolean;
    skipCurrentQualityRepair?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const allowLazyChapterPlanning = isFullBookAutopilotRunMode(input.request.runMode);
    const ownershipFence = new AutoExecutionOwnershipFence(
      this.deps,
      input.taskId,
      input.signal,
      input.existingPipelineJobId,
    );
    const runDeps: NovelDirectorAutoExecutionRuntimeDeps = {
      ...this.deps,
      ownershipFence,
      workflowService: ownershipFence.bindWorkflowService(this.deps.workflowService),
    };
    const batchRollCoordinator = new AutoExecutionBatchRollCoordinator(runDeps);
    let { range, autoExecution, pipelineJobId } = await prepareRequestedAutoExecutionState(runDeps, {
      novelId: input.novelId,
      request: input.request,
      existingState: input.existingState,
      existingPipelineJobId: input.existingPipelineJobId,
      previousFailureMessage: input.previousFailureMessage,
      allowSkipReviewBlockedChapter: input.allowSkipReviewBlockedChapter,
    });
    let knownPipelineJob: PipelineJobSnapshot = null;
    if (pipelineJobId) {
      knownPipelineJob = await resolvePipelineJobForExecution(runDeps, pipelineJobId);
      if (!knownPipelineJob || ["failed", "cancelled"].includes(knownPipelineJob.status)) {
        pipelineJobId = "";
        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(runDeps, {
          novelId: input.novelId,
          existingState: {
            ...autoExecution,
            pipelineJobId: null,
            pipelineStatus: null,
            circuitBreaker: null,
          },
          pipelineJobId: null,
          pipelineStatus: "queued",
          allowLazyChapterPlanning,
        }));
      }
    }
    try {
      if (isDirectorCircuitBreakerOpen(autoExecution.circuitBreaker)) {
        await stopAutoExecutionForCircuitBreaker(runDeps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution,
          circuitBreaker: autoExecution.circuitBreaker,
          resumeStage: input.resumeStage,
          ownershipFence,
        });
        return;
      }

      // 章节执行/质量修复正文生成是内存最高峰：进入前取 book 级内存锁（每小说同时
      // 最多 1 个高内存阶段），并在 scheduleBackgroundRun 的 finally 释放。
      if (runDeps.assertHighMemoryChapterAllowed) {
        await runDeps.assertHighMemoryChapterAllowed({
          taskId: input.taskId,
          novelId: input.novelId,
          stage: input.resumeCheckpointType === "replan_required" ? "quality_repair" : "chapter_execution",
        });
      }

      await syncAutoExecutionTaskState(runDeps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range,
        autoExecution,
        isBackgroundRunning: true,
        resumeStage: input.resumeStage,
        ownershipFence,
      });
      if (await shouldStopAutoExecution(runDeps, input.taskId, pipelineJobId || null)) {
        return;
      }

      ({ range, autoExecution, pipelineJobId } = await resolveOwnedActiveRangePipeline({
        deps: runDeps, ownershipFence, ...input, range, autoExecution,
        pipelineJobId, knownPipelineJob, allowLazyChapterPlanning,
      }));

      let consecutiveStartFailures = 0;
      let progressGuard: AutoExecutionProgressGuardState = {
        consecutiveNoProgress: 0,
        shouldStop: false,
      };
      let consecutiveBatchRolls = normalizeConsecutiveBatchRolls(autoExecution.consecutiveBatchRolls);
      const MAX_CONSECUTIVE_START_FAILURES = 3;
      const MAX_CONSECUTIVE_NO_PROGRESS = 3;
      // Independent safety net: the batch-roll cap lives inside the replaceable
      // resolveBatchRoll decision function, so a non-default implementation that
      // bypasses it (or a readiness/remaining inconsistency causing expand_range
      // with no real progress) could otherwise loop forever. Cap total iterations
      // regardless of which branch produced them.
      const MAX_RUN_FROM_READY_ITERATIONS = 200;
      let runFromReadyIterations = 0;

      autoExecutionLoop:
      while (true) {
      runFromReadyIterations += 1;
      if (runFromReadyIterations > MAX_RUN_FROM_READY_ITERATIONS) {
        await stopAutoExecutionForIterationCap({
          deps: runDeps,
          ownershipFence,
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution,
          maxIterations: MAX_RUN_FROM_READY_ITERATIONS,
        });
        return;
      }
      if (!pipelineJobId) {
        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(runDeps, {
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId: null,
          pipelineStatus: "queued",
          allowLazyChapterPlanning,
        }));
        if ((autoExecution.remainingChapterCount ?? 0) === 0) {
          const rolled = await batchRollCoordinator.tryBatchRollOnRangeExhausted({
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            consecutiveBatchRolls,
            ownershipFence,
          });
          if (rolled) {
            if (rolled.decision.kind === "halt_for_review") {
              return;
            }
            range = rolled.range;
            autoExecution = rolled.autoExecution;
            consecutiveBatchRolls = rolled.consecutiveBatchRolls;
            pipelineJobId = "";
            continue autoExecutionLoop;
          }
          await recordCompletedCheckpoint(runDeps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineStatus: "succeeded",
            ownershipFence,
          });
          return;
        }

        await ownershipFence.assertActive();
        await runDeps.workflowService.markTaskRunning(input.taskId, {
          stage: "chapter_execution",
          itemKey: "chapter_execution",
          itemLabel: `正在自动执行${buildDirectorAutoExecutionScopeLabelFromState(autoExecution, range.totalChapterCount)}`,
          progress: 0.93,
          clearCheckpoint: shouldClearAutoExecutionCheckpoint(input.resumeCheckpointType),
        });
        try {
          const job = await startAutoExecutionPipelineJob({
            deps: runDeps,
            ownershipFence,
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
          });
          pipelineJobId = job.id;
          autoExecution = {
            ...autoExecution,
            pipelineJobId: job.id,
            pipelineStatus: job.status,
          };
          consecutiveStartFailures = 0;
        } catch (error) {
          if (!isNoChaptersToGenerateError(error)) {
            consecutiveStartFailures += 1;
            if (consecutiveStartFailures >= MAX_CONSECUTIVE_START_FAILURES) {
              const startErrorMessage = error instanceof Error ? error.message : String(error);
              try {
                await ownershipFence.assertActive();
                await runDeps.workflowService.markTaskFailed(input.taskId,
                  `连续 ${MAX_CONSECUTIVE_START_FAILURES} 次启动章节生成失败，自动执行已停止。最近错误：${startErrorMessage.slice(0, 200)}`,
                  {
                    stage: "quality_repair",
                    itemKey: "chapter_execution",
                    itemLabel: "章节自动执行失败",
                    checkpointType: "chapter_batch_ready",
                    checkpointSummary: `连续启动失败 ${MAX_CONSECUTIVE_START_FAILURES} 次，可能存在章节规划或生成条件问题。`,
                    chapterId: autoExecution.nextChapterId ?? range.firstChapterId,
                    progress: 0.93,
                  },
                );
                await syncAutoExecutionTaskState(runDeps, {
                  taskId: input.taskId,
                  novelId: input.novelId,
                  request: input.request,
                  range,
                  autoExecution,
                  isBackgroundRunning: false,
                  resumeStage: "pipeline",
                  ownershipFence,
                });
              } catch (projectionError) {
                throw new AutoExecutionRunFailureError(error, projectionError);
              }
              return;
            }
            continue autoExecutionLoop;
          }
          ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(runDeps, {
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId: null,
            pipelineStatus: "succeeded",
            allowLazyChapterPlanning,
          }));
          if ((autoExecution.remainingChapterCount ?? 0) === 0) {
            const rolled = await batchRollCoordinator.tryBatchRollOnRangeExhausted({
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              consecutiveBatchRolls,
              ownershipFence,
            });
            if (rolled) {
              if (rolled.decision.kind === "halt_for_review") {
                return;
              }
              range = rolled.range;
              autoExecution = rolled.autoExecution;
              consecutiveBatchRolls = rolled.consecutiveBatchRolls;
              pipelineJobId = "";
              continue autoExecutionLoop;
            }
            await recordCompletedCheckpoint(runDeps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              pipelineStatus: "succeeded",
              ownershipFence,
            });
            return;
          }
          // 管线 skipCompleted 与 AE remaining 口径不一致：next 章有正文且已
          // terminalAction=defer_and_continue（无 replan）时，startPipeline 会空跑；
          // 强制登记 skipped 债务后重算 next，推进到下一空章，禁止 rethrow 死锁。
          const stuckChapter = await resolveStuckNoGeneratableChapter(
            runDeps,
            input.novelId,
            autoExecution,
          );
          if (stuckChapter && isDirectorAutoExecutionPipelineSkipEligibleChapter(stuckChapter)) {
            const progressCursorBefore = {
              nextChapterId: autoExecution.nextChapterId ?? null,
              nextChapterOrder: autoExecution.nextChapterOrder ?? null,
              remainingChapterCount: autoExecution.remainingChapterCount ?? 0,
            };
            const deferredState = buildDirectorAutoExecutionDeferredQualityState({
              state: autoExecution,
              reason: [
                `第${stuckChapter.order}章正文已存在且管线将 skipCompleted（defer_and_continue），`,
                "导演侧仍有不可自动放行质量债，已登记为暂存债务并继续后续空章。",
              ].join(""),
              source: "quality_loop",
              chapter: stuckChapter,
            });
            ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(runDeps, {
              novelId: input.novelId,
              existingState: deferredState,
              pipelineJobId: null,
              pipelineStatus: "queued",
              allowLazyChapterPlanning,
            }));
            progressGuard = advanceAutoExecutionProgressGuard({
              previous: progressGuard,
              before: progressCursorBefore,
              after: autoExecution,
              maxConsecutiveNoProgress: MAX_CONSECUTIVE_NO_PROGRESS,
            });
            if (progressGuard.shouldStop) {
              await stopAutoExecutionForNoProgress(runDeps, {
                taskId: input.taskId,
                novelId: input.novelId,
                request: input.request,
                range,
                autoExecution,
                maxConsecutiveNoProgress: MAX_CONSECUTIVE_NO_PROGRESS,
                source: "no-generatable defer",
                ownershipFence,
              });
              return;
            }
            pipelineJobId = "";
            await syncAutoExecutionTaskState(runDeps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: input.resumeStage,
              ownershipFence,
            });
            continue autoExecutionLoop;
          }
          throw error;
        }
        await syncAutoExecutionTaskState(runDeps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution,
          isBackgroundRunning: true,
          resumeStage: input.resumeStage,
          ownershipFence,
        });
      }

      while (pipelineJobId) {
        if (await shouldStopAutoExecution(runDeps, input.taskId, pipelineJobId)) {
          return;
        }
        const job = await resolvePipelineJobForExecution(runDeps, pipelineJobId);
        if (!job) {
          throw new Error("自动执行章节批次时未能找到对应的批量任务。");
        }
        if (job.status === "queued" || job.status === "running") {
          const runningState = resolveDirectorAutoExecutionWorkflowState(job, range, autoExecution);
          await ownershipFence.assertActive();
          await runDeps.workflowService.markTaskRunning(input.taskId, {
            ...runningState,
            clearCheckpoint: shouldClearAutoExecutionCheckpoint(input.resumeCheckpointType),
          });
          ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(runDeps, {
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
            allowLazyChapterPlanning,
          }));
          await syncAutoExecutionTaskState(runDeps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            isBackgroundRunning: true,
            resumeStage: "pipeline",
            ownershipFence,
          });
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(runDeps, {
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId,
          pipelineStatus: job.status,
          allowLazyChapterPlanning,
        }));
        const usageCircuitBreaker = await resolveUsageCircuitBreaker({
          taskId: input.taskId,
          novelId: input.novelId,
          autoExecution,
        });
        if (usageCircuitBreaker) {
          autoExecution = withCircuitBreakerState(autoExecution, usageCircuitBreaker);
          if (isDirectorCircuitBreakerOpen(usageCircuitBreaker)) {
            await stopAutoExecutionForCircuitBreaker(runDeps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              circuitBreaker: usageCircuitBreaker,
              resumeStage: "pipeline",
              ownershipFence,
            });
            return;
          }
          await syncAutoExecutionTaskState(runDeps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            isBackgroundRunning: true,
            resumeStage: "pipeline",
            ownershipFence,
          });
        }

        if (job.status === "succeeded" && job.noticeSummary?.trim()) {
          const qualityIssueChapter = await resolveQualityIssueChapter(runDeps, input.novelId, job);
          const noticeAction = await resolveQualityRepairNoticeAction(runDeps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
            noticeCode: job.noticeCode,
            noticeSummary: job.noticeSummary.trim(),
            payload: job.payload,
            approveAutoExecutionScope: input.approveAutoExecutionScope,
            skipCurrentQualityRepair: input.skipCurrentQualityRepair,
            qualityIssueChapter,
          });
          if (noticeAction.action === "auto_continue") {
            pipelineJobId = "";
            progressGuard = { consecutiveNoProgress: 0, shouldStop: false };
            ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(runDeps, {
              novelId: input.novelId,
              existingState: noticeAction.checkpointState,
              pipelineJobId: null,
              pipelineStatus: "queued",
              allowLazyChapterPlanning,
            }));
            await syncAutoExecutionTaskState(runDeps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: "pipeline",
              ownershipFence,
            });
            continue autoExecutionLoop;
          }

          await recordQualityRepairCheckpoint(runDeps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
            checkpointType: noticeAction.checkpointType,
            pauseMessage: job.noticeSummary.trim(),
            qualityRepairRisk: noticeAction.qualityRepairRisk,
            ownershipFence,
          });
          await syncAutoExecutionTaskState(runDeps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution: noticeAction.checkpointState,
            isBackgroundRunning: false,
            resumeStage: "pipeline",
            ownershipFence,
          });
          return;
        }

        if (job.status === "succeeded") {
          const completedPipelineJobId = pipelineJobId;
          pipelineJobId = "";
          progressGuard = { consecutiveNoProgress: 0, shouldStop: false };
          if ((autoExecution.remainingChapterCount ?? 0) > 0) {
            if (runDeps.autoConfirmPendingCandidates) {
              await ownershipFence.assertActive();
              await runDeps.autoConfirmPendingCandidates(input.novelId).catch(() => null);
            }
            await schedulePendingReviewAutoPromotionIfEnabled(runDeps, {
              novelId: input.novelId,
              taskId: input.taskId,
              ownershipFence,
            });
            await syncAutoExecutionTaskState(runDeps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: "pipeline",
              ownershipFence,
            });
            continue autoExecutionLoop;
          }
          const rolledAfterSuccess = await batchRollCoordinator.tryBatchRollOnRangeExhausted({
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            consecutiveBatchRolls,
            ownershipFence,
          });
          if (rolledAfterSuccess) {
            if (rolledAfterSuccess.decision.kind === "halt_for_review") {
              return;
            }
            range = rolledAfterSuccess.range;
            autoExecution = rolledAfterSuccess.autoExecution;
            consecutiveBatchRolls = rolledAfterSuccess.consecutiveBatchRolls;
            pipelineJobId = "";
            continue autoExecutionLoop;
          }
          await recordCompletedCheckpoint(runDeps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId: completedPipelineJobId,
            pipelineStatus: job.status,
            ownershipFence,
          });
          return;
        }

        if ((autoExecution.remainingChapterCount ?? 0) === 0) {
          const rolledAfterTerminal = await batchRollCoordinator.tryBatchRollOnRangeExhausted({
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            consecutiveBatchRolls,
            ownershipFence,
          });
          if (rolledAfterTerminal) {
            if (rolledAfterTerminal.decision.kind === "halt_for_review") {
              return;
            }
            range = rolledAfterTerminal.range;
            autoExecution = rolledAfterTerminal.autoExecution;
            consecutiveBatchRolls = rolledAfterTerminal.consecutiveBatchRolls;
            pipelineJobId = "";
            continue autoExecutionLoop;
          }
          await recordCompletedCheckpoint(runDeps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
            ownershipFence,
          });
          return;
        }

        const failureOutcome = await handleAutoExecutionFailure({
          deps: runDeps,
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution,
          pipelineJobId,
          job,
          allowLazyChapterPlanning,
          progressGuard,
          maxConsecutiveNoProgress: MAX_CONSECUTIVE_NO_PROGRESS,
          resolveQualityIssueChapter: () => resolveQualityIssueChapter(runDeps, input.novelId, job),
          ownershipFence,
        });
        if (failureOutcome.kind === "continue") {
          range = failureOutcome.range;
          autoExecution = failureOutcome.autoExecution;
          progressGuard = failureOutcome.progressGuard;
          pipelineJobId = "";
          continue autoExecutionLoop;
        }
        return;
      }
      return;
      }
    } catch (error) {
      if (isAutoExecutionRunFailure(error)) {
        throw error;
      }
      if (isAutoExecutionOwnershipLost(error)) {
        return;
      }
      // Safety net: ensure the task is not left in a phantom "running" state
      // (isBackgroundRunning) if runFromReady threw before reaching a terminal
      // markTaskRunning/markTaskFailed/markTaskCompleted call. A lingering running
      // state would block forceResume on the next continue. The original error is
      // re-thrown so the caller still sees the real root cause — this does not mask
      // or swallow it, only guarantees the persisted auto-execution flag is cleared.
      let cleanupError: unknown;
      try {
        await syncAutoExecutionTaskState(runDeps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution: {
            ...autoExecution,
            pipelineJobId: null,
            pipelineStatus: null,
          },
          isBackgroundRunning: false,
          resumeStage: input.resumeStage,
          ownershipFence,
        });
      } catch (caught) {
        cleanupError = caught;
      }
      try {
        await runDeps.workflowService.markTaskFailed(
          input.taskId,
          error instanceof Error ? error.message : "自动执行基础设施失败。",
          {
            stage: "chapter_execution",
            itemKey: "auto_execution_failure",
            itemLabel: "自动执行失败，等待重试或恢复",
          },
        );
      } catch (projectionError) {
        throw new AutoExecutionRunFailureError(error, projectionError);
      }
      throw new AutoExecutionRunFailureError(error, cleanupError);
    }
  }

}
