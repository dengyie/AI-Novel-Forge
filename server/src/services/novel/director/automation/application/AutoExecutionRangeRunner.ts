import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import { isFullBookAutopilotRunMode } from "@ai-novel/shared/types/novelDirector";
import {
  buildDirectorAutoExecutionScopeLabelFromState,
  buildDirectorAutoExecutionDeferredQualityState,
  buildDirectorAutoExecutionPipelineOptions,
  isDirectorAutoExecutionPipelineSkipEligibleChapter,
  normalizeConsecutiveBatchRolls,
  resolveDirectorAutoExecutionRepairMode,
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
  resolveSingleChapterExecutionRange,
  shouldClearAutoExecutionCheckpoint,
} from "../novelDirectorAutoExecutionRuntimeUtils";
import { prepareRequestedAutoExecution as prepareRequestedAutoExecutionState, resolveAutoExecutionRuntimeRangeAndState, shouldStopAutoExecution } from "../novelDirectorAutoExecutionRuntimePreparation";
import type { NovelDirectorAutoExecutionRuntimeDeps, PipelineJobSnapshot } from "../novelDirectorAutoExecutionRuntimePorts";
import {
  advanceAutoExecutionProgressGuard,
  type AutoExecutionProgressGuardState,
} from "../domain/AutoExecutionProgressPolicy";
import {
  schedulePendingReviewAutoPromotionIfEnabled,
  stopAutoExecutionForNoProgress,
} from "../projections/AutoExecutionTaskProjector";
import { AutoExecutionBatchRollCoordinator } from "./AutoExecutionBatchRollCoordinator";
import { handleAutoExecutionFailure } from "./AutoExecutionFailureHandler";
import {
  resolvePipelineJobForExecution,
  resolveQualityIssueChapter,
  resolveStuckNoGeneratableChapter,
} from "./AutoExecutionChapterResolver";

export { schedulePendingReviewAutoPromotionIfEnabled } from "../projections/AutoExecutionTaskProjector";
export class AutoExecutionRangeRunner {
  private readonly batchRollCoordinator: AutoExecutionBatchRollCoordinator;

  constructor(private readonly deps: NovelDirectorAutoExecutionRuntimeDeps) {
    this.batchRollCoordinator = new AutoExecutionBatchRollCoordinator(deps);
  }


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
  }): Promise<void> {
    const allowLazyChapterPlanning = isFullBookAutopilotRunMode(input.request.runMode);
    let { range, autoExecution, pipelineJobId } = await prepareRequestedAutoExecutionState(this.deps, {
      novelId: input.novelId,
      request: input.request,
      existingState: input.existingState,
      existingPipelineJobId: input.existingPipelineJobId,
      previousFailureMessage: input.previousFailureMessage,
      allowSkipReviewBlockedChapter: input.allowSkipReviewBlockedChapter,
    });
    let knownPipelineJob: PipelineJobSnapshot = null;
    if (pipelineJobId) {
        knownPipelineJob = await resolvePipelineJobForExecution(this.deps, pipelineJobId);
      if (!knownPipelineJob || ["failed", "cancelled"].includes(knownPipelineJob.status)) {
        pipelineJobId = "";
        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
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
    if (isDirectorCircuitBreakerOpen(autoExecution.circuitBreaker)) {
      await stopAutoExecutionForCircuitBreaker(this.deps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range,
        autoExecution,
        circuitBreaker: autoExecution.circuitBreaker,
        resumeStage: input.resumeStage,
      });
      return;
    }

    // 章节执行/质量修复正文生成是内存最高峰：进入前取 book 级内存锁（每小说同时
    // 最多 1 个高内存阶段），并在 scheduleBackgroundRun 的 finally 释放。
    if (this.deps.assertHighMemoryChapterAllowed) {
      await this.deps.assertHighMemoryChapterAllowed({
        taskId: input.taskId,
        novelId: input.novelId,
        stage: input.resumeCheckpointType === "replan_required" ? "quality_repair" : "chapter_execution",
      });
    }

    try {
      await syncAutoExecutionTaskState(this.deps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range,
        autoExecution,
        isBackgroundRunning: true,
        resumeStage: input.resumeStage,
      });
      if (await shouldStopAutoExecution(this.deps, input.taskId, pipelineJobId || null)) {
        return;
      }

      if (pipelineJobId) {
        const existingJob = knownPipelineJob
          ?? await resolvePipelineJobForExecution(this.deps, pipelineJobId);
        knownPipelineJob = existingJob;
        if (!existingJob || ["failed", "cancelled"].includes(existingJob.status)) {
          pipelineJobId = "";
        }
      }

      const activeRangeJob = await this.deps.novelService.findActivePipelineJobForRange(
        input.novelId,
        resolveSingleChapterExecutionRange(range, autoExecution).startOrder,
        resolveSingleChapterExecutionRange(range, autoExecution).endOrder,
        pipelineJobId || null,
      );
      if (activeRangeJob) {
        pipelineJobId = activeRangeJob.id;
        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId,
          pipelineStatus: activeRangeJob.status,
          allowLazyChapterPlanning,
        }));
        await syncAutoExecutionTaskState(this.deps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution,
          isBackgroundRunning: true,
          resumeStage: input.resumeStage,
        });
      }

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
        await this.deps.workflowService.markTaskFailed(
          input.taskId,
          `自动执行循环已超过 ${MAX_RUN_FROM_READY_ITERATIONS} 次迭代上限，已停止以防止死循环。`,
          {
            stage: "chapter_execution",
            itemKey: "batch_roll_iteration_cap",
            itemLabel: "自动执行循环超限",
            checkpointType: "chapter_batch_ready",
            checkpointSummary: `连续迭代超过 ${MAX_RUN_FROM_READY_ITERATIONS} 次仍未推进，可能存在 readiness 与实际章节数据不一致或决策函数未执行 cap。`,
            chapterId: autoExecution.nextChapterId ?? range.firstChapterId,
            progress: 0.93,
          },
        );
        await syncAutoExecutionTaskState(this.deps, {
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
          resumeStage: "pipeline",
        });
        return;
      }
      if (!pipelineJobId) {
        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId: null,
          pipelineStatus: "queued",
          allowLazyChapterPlanning,
        }));
        if ((autoExecution.remainingChapterCount ?? 0) === 0) {
          const rolled = await this.batchRollCoordinator.tryBatchRollOnRangeExhausted({
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            consecutiveBatchRolls,
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
          await recordCompletedCheckpoint(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineStatus: "succeeded",
          });
          return;
        }

        await this.deps.workflowService.markTaskRunning(input.taskId, {
          stage: "chapter_execution",
          itemKey: "chapter_execution",
          itemLabel: `正在自动执行${buildDirectorAutoExecutionScopeLabelFromState(autoExecution, range.totalChapterCount)}`,
          progress: 0.93,
          clearCheckpoint: shouldClearAutoExecutionCheckpoint(input.resumeCheckpointType),
        });
        try {
          const job = await this.deps.novelService.startPipelineJob(
            input.novelId,
            buildDirectorAutoExecutionPipelineOptions({
              provider: input.request.provider,
              model: input.request.model,
              temperature: input.request.temperature,
              workflowTaskId: input.taskId,
              taskStyleProfileId: input.request.styleProfileId,
              controlAdvanceMode: isFullBookAutopilotRunMode(input.request.runMode)
                ? "full_book_autopilot"
                : "auto_to_execution",
              ...resolveSingleChapterExecutionRange(range, autoExecution),
              autoReview: autoExecution.autoReview,
              autoRepair: autoExecution.autoRepair,
              artifactSyncMode: autoExecution.artifactSyncMode,
              repairMode: resolveDirectorAutoExecutionRepairMode(autoExecution),
              settingQualityMode: input.request.settingQualityMode ?? "off",
            }),
          );
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
              await this.deps.workflowService.markTaskFailed(input.taskId,
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
              await syncAutoExecutionTaskState(this.deps, {
                taskId: input.taskId,
                novelId: input.novelId,
                request: input.request,
                range,
                autoExecution,
                isBackgroundRunning: false,
                resumeStage: "pipeline",
              });
              return;
            }
            continue autoExecutionLoop;
          }
          ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId: null,
            pipelineStatus: "succeeded",
            allowLazyChapterPlanning,
          }));
          if ((autoExecution.remainingChapterCount ?? 0) === 0) {
            const rolled = await this.batchRollCoordinator.tryBatchRollOnRangeExhausted({
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              consecutiveBatchRolls,
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
            await recordCompletedCheckpoint(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              pipelineStatus: "succeeded",
            });
            return;
          }
          // 管线 skipCompleted 与 AE remaining 口径不一致：next 章有正文且已
          // terminalAction=defer_and_continue（无 replan）时，startPipeline 会空跑；
          // 强制登记 skipped 债务后重算 next，推进到下一空章，禁止 rethrow 死锁。
          const stuckChapter = await resolveStuckNoGeneratableChapter(
            this.deps,
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
            ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
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
              await stopAutoExecutionForNoProgress(this.deps, {
                taskId: input.taskId,
                novelId: input.novelId,
                request: input.request,
                range,
                autoExecution,
                maxConsecutiveNoProgress: MAX_CONSECUTIVE_NO_PROGRESS,
                source: "no-generatable defer",
              });
              return;
            }
            pipelineJobId = "";
            await syncAutoExecutionTaskState(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: input.resumeStage,
            });
            continue autoExecutionLoop;
          }
          throw error;
        }
        await syncAutoExecutionTaskState(this.deps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution,
          isBackgroundRunning: true,
          resumeStage: input.resumeStage,
        });
      }

      while (pipelineJobId) {
        if (await shouldStopAutoExecution(this.deps, input.taskId, pipelineJobId)) {
          return;
        }
        const job = await resolvePipelineJobForExecution(this.deps, pipelineJobId);
        if (!job) {
          throw new Error("自动执行章节批次时未能找到对应的批量任务。");
        }
        if (job.status === "queued" || job.status === "running") {
          const runningState = resolveDirectorAutoExecutionWorkflowState(job, range, autoExecution);
          await this.deps.workflowService.markTaskRunning(input.taskId, {
            ...runningState,
            clearCheckpoint: shouldClearAutoExecutionCheckpoint(input.resumeCheckpointType),
          });
          ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
            allowLazyChapterPlanning,
          }));
          await syncAutoExecutionTaskState(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            isBackgroundRunning: true,
            resumeStage: "pipeline",
          });
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
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
            await stopAutoExecutionForCircuitBreaker(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              circuitBreaker: usageCircuitBreaker,
              resumeStage: "pipeline",
            });
            return;
          }
          await syncAutoExecutionTaskState(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            isBackgroundRunning: true,
            resumeStage: "pipeline",
          });
        }

        if (job.status === "succeeded" && job.noticeSummary?.trim()) {
          const qualityIssueChapter = await resolveQualityIssueChapter(this.deps, input.novelId, job);
          const noticeAction = await resolveQualityRepairNoticeAction(this.deps, {
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
            ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
              novelId: input.novelId,
              existingState: noticeAction.checkpointState,
              pipelineJobId: null,
              pipelineStatus: "queued",
              allowLazyChapterPlanning,
            }));
            await syncAutoExecutionTaskState(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: "pipeline",
            });
            continue autoExecutionLoop;
          }

          await recordQualityRepairCheckpoint(this.deps, {
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
          });
          await syncAutoExecutionTaskState(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution: noticeAction.checkpointState,
            isBackgroundRunning: false,
            resumeStage: "pipeline",
          });
          return;
        }

        if (job.status === "succeeded") {
          const completedPipelineJobId = pipelineJobId;
          pipelineJobId = "";
          progressGuard = { consecutiveNoProgress: 0, shouldStop: false };
          if ((autoExecution.remainingChapterCount ?? 0) > 0) {
            if (this.deps.autoConfirmPendingCandidates) {
              await this.deps.autoConfirmPendingCandidates(input.novelId).catch(() => null);
            }
            schedulePendingReviewAutoPromotionIfEnabled(this.deps, {
              novelId: input.novelId,
              taskId: input.taskId,
            });
            await syncAutoExecutionTaskState(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: "pipeline",
            });
            continue autoExecutionLoop;
          }
          const rolledAfterSuccess = await this.batchRollCoordinator.tryBatchRollOnRangeExhausted({
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            consecutiveBatchRolls,
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
          await recordCompletedCheckpoint(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId: completedPipelineJobId,
            pipelineStatus: job.status,
          });
          return;
        }

        if ((autoExecution.remainingChapterCount ?? 0) === 0) {
          const rolledAfterTerminal = await this.batchRollCoordinator.tryBatchRollOnRangeExhausted({
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            consecutiveBatchRolls,
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
          await recordCompletedCheckpoint(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
          });
          return;
        }

        const failureOutcome = await handleAutoExecutionFailure({
          deps: this.deps,
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
          resolveQualityIssueChapter: () => resolveQualityIssueChapter(this.deps, input.novelId, job),
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
      // Safety net: ensure the task is not left in a phantom "running" state
      // (isBackgroundRunning) if runFromReady threw before reaching a terminal
      // markTaskRunning/markTaskFailed/markTaskCompleted call. A lingering running
      // state would block forceResume on the next continue. The original error is
      // re-thrown so the caller still sees the real root cause — this does not mask
      // or swallow it, only guarantees the persisted auto-execution flag is cleared.
      try {
        await syncAutoExecutionTaskState(this.deps, {
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
        });
      } catch {
        // best-effort cleanup; the original error below is the signal that matters
      }
      throw error;
    }
  }

}
