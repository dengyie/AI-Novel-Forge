import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
  DirectorQualityRepairRisk,
} from "@ai-novel/shared/types/novelDirector";
import { isFullBookAutopilotRunMode } from "@ai-novel/shared/types/novelDirector";
import type { NovelControlPolicy } from "@ai-novel/shared/types/canonicalState";
import type { PipelineJobStatus, VolumePlanDocument } from "@ai-novel/shared/types/novel";
import type { NovelWorkflowCheckpoint } from "@ai-novel/shared/types/novelWorkflow";
import {
  buildDirectorAutoExecutionPausedLabel,
  buildDirectorAutoExecutionPausedSummary,
  buildDirectorAutoExecutionScopeLabelFromState,
  buildDirectorAutoExecutionPipelineOptions,
  resolveDirectorAutoExecutionWorkflowState,
  type DirectorAutoExecutionChapterRef,
  type DirectorAutoExecutionRange,
} from "./novelDirectorAutoExecution";
import {
  recordCompletedCheckpoint,
  recordQualityRepairCheckpoint,
  resolveQualityRepairNoticeAction,
  syncAutoExecutionTaskState,
  type AutoExecutionResumeStage,
} from "./novelDirectorAutoExecutionCheckpointRuntime";
import {
  applyReviewSkipOverride,
  buildRequestedAutoExecutionState,
  resolveAutoExecutionRangeAndState,
} from "./novelDirectorAutoExecutionScopeRuntime";
import { isSkippableAutoExecutionReviewFailure } from "./novelDirectorAutoExecutionFailure";
import {
  buildFailureCircuitBreaker,
  isDirectorCircuitBreakerOpen,
  resolveUsageCircuitBreaker,
  runFullBookAutopilotReplanNotice,
  stopAutoExecutionForCircuitBreaker,
  withCircuitBreakerState,
} from "./novelDirectorAutoExecutionCircuitBreakerRuntime";
import {
  isNoChaptersToGenerateError,
  resolveSingleChapterExecutionRange,
  shouldClearAutoExecutionCheckpoint,
} from "./novelDirectorAutoExecutionRuntimeUtils";
import { directorAutomationLedgerEventService } from "./runtime/DirectorAutomationLedgerEventService";

interface NovelDirectorAutoExecutionWorkflowPort {
  bootstrapTask(input: {
    workflowTaskId: string;
    novelId: string;
    lane: "auto_director";
    title: string;
    seedPayload?: Record<string, unknown>;
  }): Promise<unknown>;
  getTaskById(taskId: string): Promise<{ status: string } | null>;
  markTaskRunning(taskId: string, input: {
    stage: "chapter_execution" | "quality_repair";
    itemLabel: string;
    itemKey?: string | null;
    progress?: number;
    clearCheckpoint?: boolean;
  }): Promise<unknown>;
  recordCheckpoint(taskId: string, input: {
    stage: "quality_repair";
    checkpointType: "workflow_completed" | "chapter_batch_ready" | "replan_required";
    checkpointSummary: string;
    itemLabel: string;
    progress?: number;
    chapterId?: string | null;
    seedPayload?: Record<string, unknown>;
  }): Promise<unknown>;
  markTaskFailed(taskId: string, message: string, patch?: {
    stage?: "quality_repair";
    itemKey?: string | null;
    itemLabel?: string;
    checkpointType?: "chapter_batch_ready" | "replan_required";
    checkpointSummary?: string | null;
    chapterId?: string | null;
    progress?: number;
  }): Promise<unknown>;
}

interface NovelDirectorAutoExecutionNovelPort {
  listChapters(novelId: string): Promise<DirectorAutoExecutionChapterRef[]>;
  startPipelineJob(novelId: string, options: {
    provider?: string;
    model?: string;
    temperature?: number;
    startOrder: number;
    endOrder: number;
    controlPolicy?: NovelControlPolicy;
    taskStyleProfileId?: string;
    maxRetries: number;
    runMode: "fast" | "polish";
    autoReview: boolean;
    autoRepair: boolean;
    skipCompleted: boolean;
    qualityThreshold: number;
    repairMode: "light_repair";
  }): Promise<{ id: string; status: PipelineJobStatus }>;
  findActivePipelineJobForRange(
    novelId: string,
    startOrder: number,
    endOrder: number,
    preferredJobId?: string | null,
  ): Promise<{ id: string; status: PipelineJobStatus } | null>;
  getPipelineJobById(jobId: string): Promise<{
    id: string;
    status: PipelineJobStatus;
    progress: number;
    currentStage?: string | null;
    currentItemLabel?: string | null;
    noticeCode?: string | null;
    payload?: string | null;
    noticeSummary?: string | null;
    error?: string | null;
  } | null>;
  cancelPipelineJob(jobId: string): Promise<unknown>;
}

type PipelineJobSnapshot = Awaited<ReturnType<NovelDirectorAutoExecutionNovelPort["getPipelineJobById"]>>;

interface NovelDirectorAutoExecutionVolumeWorkspacePort {
  getVolumes(novelId: string): Promise<VolumePlanDocument>;
}

interface NovelDirectorAutoExecutionRuntimeDeps {
  novelContextService: Pick<NovelDirectorAutoExecutionNovelPort, "listChapters">;
  novelService: Pick<
    NovelDirectorAutoExecutionNovelPort,
    "startPipelineJob" | "findActivePipelineJobForRange" | "getPipelineJobById" | "cancelPipelineJob"
  >;
  volumeWorkspaceService?: Pick<NovelDirectorAutoExecutionVolumeWorkspacePort, "getVolumes">;
  workflowService: NovelDirectorAutoExecutionWorkflowPort;
  buildDirectorSeedPayload: (
    input: DirectorConfirmRequest,
    novelId: string,
    extra?: Record<string, unknown>,
  ) => Record<string, unknown>;
  shouldAutoContinueQualityRepair?: (input: {
    request: DirectorConfirmRequest;
    qualityRepairRisk: DirectorQualityRepairRisk;
    remainingChapterCount: number;
  }) => Promise<boolean> | boolean;
  recordAutoApproval?: (input: {
    taskId: string;
    checkpointType: NovelWorkflowCheckpoint;
    qualityRepairRisk: DirectorQualityRepairRisk;
    checkpointSummary?: string | null;
  }) => Promise<unknown>;
  replanNovel?: (novelId: string, input: {
    chapterId?: string;
    triggerType?: string;
    reason: string;
    sourceIssueIds?: string[];
    windowSize?: number;
    provider?: DirectorConfirmRequest["provider"];
    model?: string;
    temperature?: number;
  }) => Promise<unknown>;
}

export class NovelDirectorAutoExecutionRuntime {
  constructor(private readonly deps: NovelDirectorAutoExecutionRuntimeDeps) {}

  private async resolveRangeAndState(input: {
    novelId: string;
    existingState?: DirectorAutoExecutionState | null;
    pipelineJobId?: string | null;
    pipelineStatus?: PipelineJobStatus | null;
  }): Promise<{
    range: DirectorAutoExecutionRange;
    autoExecution: DirectorAutoExecutionState;
  }> {
    return resolveAutoExecutionRangeAndState({
      novelId: input.novelId,
      deps: {
        listChapters: (novelId) => this.deps.novelContextService.listChapters(novelId),
        getVolumes: this.deps.volumeWorkspaceService
          ? (novelId) => this.deps.volumeWorkspaceService?.getVolumes(novelId) as Promise<VolumePlanDocument>
          : undefined,
      },
      existingState: input.existingState,
      pipelineJobId: input.pipelineJobId,
      pipelineStatus: input.pipelineStatus,
    });
  }

  async prepareRequestedAutoExecution(input: {
    novelId: string;
    request: DirectorConfirmRequest;
    existingState?: DirectorAutoExecutionState | null;
    existingPipelineJobId?: string | null;
    previousFailureMessage?: string | null;
    allowSkipReviewBlockedChapter?: boolean;
  }): Promise<{
    range: DirectorAutoExecutionRange;
    autoExecution: DirectorAutoExecutionState;
    pipelineJobId: string;
  }> {
    const shouldSkipReviewBlockedChapter = Boolean(
      input.allowSkipReviewBlockedChapter
      && isSkippableAutoExecutionReviewFailure(input.previousFailureMessage),
    );
    const pipelineJobId = shouldSkipReviewBlockedChapter
      ? ""
      : (input.existingPipelineJobId?.trim() || "");
    const existingState = applyReviewSkipOverride({
      existingState: input.existingState,
      previousFailureMessage: input.previousFailureMessage,
      allowSkipReviewBlockedChapter: input.allowSkipReviewBlockedChapter,
    });
    const requestedExecutionState = buildRequestedAutoExecutionState({
      request: input.request,
      existingState,
      existingPipelineJobId: pipelineJobId || null,
    });
    const { range, autoExecution } = await this.resolveRangeAndState({
      novelId: input.novelId,
      existingState: requestedExecutionState,
      pipelineJobId: pipelineJobId || null,
      pipelineStatus: pipelineJobId ? "running" : "queued",
    });
    return {
      range,
      autoExecution,
      pipelineJobId,
    };
  }

  private async shouldStopAutoExecution(taskId: string, pipelineJobId?: string | null): Promise<boolean> {
    const row = await this.deps.workflowService.getTaskById(taskId);
    if (!row || row.status !== "cancelled") {
      return false;
    }
    if (pipelineJobId) {
      await this.deps.novelService.cancelPipelineJob(pipelineJobId).catch(() => null);
    }
    return true;
  }

  async runFromReady(input: {
    taskId: string;
    novelId: string;
    request: DirectorConfirmRequest;
    existingPipelineJobId?: string | null;
    existingState?: DirectorAutoExecutionState | null;
    resumeCheckpointType?: "front10_ready" | "chapter_batch_ready" | "replan_required" | null;
    resumeStage?: AutoExecutionResumeStage;
    previousFailureMessage?: string | null;
    allowSkipReviewBlockedChapter?: boolean;
  }): Promise<void> {
    let { range, autoExecution, pipelineJobId } = await this.prepareRequestedAutoExecution({
      novelId: input.novelId,
      request: input.request,
      existingState: input.existingState,
      existingPipelineJobId: input.existingPipelineJobId,
      previousFailureMessage: input.previousFailureMessage,
      allowSkipReviewBlockedChapter: input.allowSkipReviewBlockedChapter,
    });
    let knownPipelineJob: PipelineJobSnapshot = null;
    if (pipelineJobId) {
      knownPipelineJob = await this.deps.novelService.getPipelineJobById(pipelineJobId);
      if (!knownPipelineJob || ["failed", "cancelled"].includes(knownPipelineJob.status)) {
        pipelineJobId = "";
        ({ range, autoExecution } = await this.resolveRangeAndState({
          novelId: input.novelId,
          existingState: {
            ...autoExecution,
            pipelineJobId: null,
            pipelineStatus: null,
            circuitBreaker: null,
          },
          pipelineJobId: null,
          pipelineStatus: "queued",
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
      if (await this.shouldStopAutoExecution(input.taskId, pipelineJobId || null)) {
        return;
      }

      if (pipelineJobId) {
        const existingJob = knownPipelineJob ?? await this.deps.novelService.getPipelineJobById(pipelineJobId);
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
        ({ range, autoExecution } = await this.resolveRangeAndState({
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId,
          pipelineStatus: activeRangeJob.status,
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

      autoExecutionLoop:
      while (true) {
      if (!pipelineJobId) {
        ({ range, autoExecution } = await this.resolveRangeAndState({
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId: null,
          pipelineStatus: "queued",
        }));
        if ((autoExecution.remainingChapterCount ?? 0) === 0) {
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
            }),
          );
          pipelineJobId = job.id;
          autoExecution = {
            ...autoExecution,
            pipelineJobId: job.id,
            pipelineStatus: job.status,
          };
        } catch (error) {
          if (!isNoChaptersToGenerateError(error)) {
            throw error;
          }
          ({ range, autoExecution } = await this.resolveRangeAndState({
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId: null,
            pipelineStatus: "succeeded",
          }));
          if ((autoExecution.remainingChapterCount ?? 0) === 0) {
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
        if (await this.shouldStopAutoExecution(input.taskId, pipelineJobId)) {
          return;
        }
        const job = await this.deps.novelService.getPipelineJobById(pipelineJobId);
        if (!job) {
          throw new Error("自动执行章节批次时未能找到对应的批量任务。");
        }
        if (job.status === "queued" || job.status === "running") {
          const runningState = resolveDirectorAutoExecutionWorkflowState(job, range, autoExecution);
          await this.deps.workflowService.markTaskRunning(input.taskId, {
            ...runningState,
            clearCheckpoint: shouldClearAutoExecutionCheckpoint(input.resumeCheckpointType),
          });
          ({ range, autoExecution } = await this.resolveRangeAndState({
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
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

        ({ range, autoExecution } = await this.resolveRangeAndState({
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId,
          pipelineStatus: job.status,
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
          });
          if (
            noticeAction.checkpointType === "replan_required"
            && (input.request.runMode === "auto_to_execution" || isFullBookAutopilotRunMode(input.request.runMode))
          ) {
            const replanNoticeResult = isFullBookAutopilotRunMode(input.request.runMode)
              ? await runFullBookAutopilotReplanNotice({
                deps: this.deps,
                taskId: input.taskId,
                novelId: input.novelId,
                request: input.request,
                range,
                autoExecution,
                checkpointState: noticeAction.checkpointState,
                noticeSummary: job.noticeSummary.trim(),
              })
              : { stopped: false as const, circuitBreaker: autoExecution.circuitBreaker ?? null };
            if (replanNoticeResult.stopped) {
              return;
            }
            await this.deps.recordAutoApproval?.({
              taskId: input.taskId,
              checkpointType: noticeAction.checkpointType,
              qualityRepairRisk: noticeAction.qualityRepairRisk,
              checkpointSummary: job.noticeSummary.trim(),
            });
            pipelineJobId = "";
            ({ range, autoExecution } = await this.resolveRangeAndState({
              novelId: input.novelId,
              existingState: withCircuitBreakerState(noticeAction.checkpointState, replanNoticeResult.circuitBreaker),
              pipelineJobId: null,
              pipelineStatus: "queued",
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
          if (noticeAction.action === "auto_continue") {
            pipelineJobId = "";
            ({ range, autoExecution } = await this.resolveRangeAndState({
              novelId: input.novelId,
              existingState: noticeAction.checkpointState,
              pipelineJobId: null,
              pipelineStatus: "queued",
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
          if ((autoExecution.remainingChapterCount ?? 0) > 0) {
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

        const scopeLabel = buildDirectorAutoExecutionScopeLabelFromState(autoExecution, range.totalChapterCount);
        const failureMessage = job.error?.trim()
          || (job.status === "cancelled"
            ? `${scopeLabel}自动执行已取消。`
            : `${scopeLabel}自动执行未能全部通过质量要求。`);
        const failureCircuitBreaker = buildFailureCircuitBreaker({
          autoExecution,
          jobStatus: job.status,
          message: failureMessage,
        });
        const failedAutoExecution = withCircuitBreakerState({
          ...autoExecution,
          pipelineJobId,
          pipelineStatus: job.status,
        }, failureCircuitBreaker);
        if (autoExecution.autoRepair && job.status !== "cancelled") {
          await directorAutomationLedgerEventService.recordRepairTicketCreated({
            taskId: input.taskId,
            novelId: input.novelId,
            chapterId: autoExecution.nextChapterId ?? null,
            summary: failureMessage,
            failureCount: failureCircuitBreaker.patchFailureCount ?? failureCircuitBreaker.failureCount ?? 1,
            metadata: {
              pipelineJobId,
              pipelineStatus: job.status,
              chapterOrder: autoExecution.nextChapterOrder ?? null,
            },
          }).catch(() => null);
        }
        if (isDirectorCircuitBreakerOpen(failureCircuitBreaker)) {
          await stopAutoExecutionForCircuitBreaker(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution: failedAutoExecution,
            circuitBreaker: failureCircuitBreaker,
            resumeStage: "pipeline",
          });
          return;
        }
        await this.deps.workflowService.markTaskFailed(input.taskId, failureMessage, {
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
        await syncAutoExecutionTaskState(this.deps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution: failedAutoExecution,
          isBackgroundRunning: false,
          resumeStage: "pipeline",
        });
        return;
      }
      return;
      }
    } catch (error) {
      throw error;
    }
  }
}
