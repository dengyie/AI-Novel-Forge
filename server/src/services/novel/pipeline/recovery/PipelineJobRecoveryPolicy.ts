import { prisma } from "../../../../db/prisma";
import { novelEventBus } from "../../../../events";
import {
  logPipelineError,
  logPipelineWarn,
  type PipelinePayload,
  type PipelineRunOptions,
} from "../../novelCoreShared";
import {
  formatPipelineJobAutoRetryMessage,
  isPipelineCancellationError,
  normalizeJobTransportAutoRetryCount,
  PIPELINE_JOB_AUTO_RETRY_RECOVERY_IN_PROCESS_TIMER,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
  shouldAutoRetryPipelineJob,
} from "../../pipelineJobAutoRetry";
import {
  buildPipelineJobAutoRequeueCasWhere,
  isPipelineLeaseLostError,
} from "../../pipelineJobTerminalGuard";
import { clampPipelineMaxRetries } from "../../pipelineExecutionHelpers";
import { isChapterChineseProseGateError } from "../../runtime/chapterChineseProseGateError";
import { isChapterEmptyContentError } from "../../runtime/chapterEmptyContentError";
import type { PipelineExecuteHost } from "../execution/PipelineChapterExecution";

export async function recoverPipelineJob(input: {
  error: unknown;
  host: PipelineExecuteHost;
  jobId: string;
  novelId: string;
  options: PipelineRunOptions;
  runtimePayload: PipelinePayload;
  totalRetryCount: number;
  qualityAlertDetails: string[];
  replanAlertDetails: string[];
  genreBeatAlertDetails: string[];
  recoverableRepairDetails: string[];
}): Promise<void> {
  const {
    error,
    host,
    jobId,
    novelId,
    options,
    runtimePayload,
    totalRetryCount,
    qualityAlertDetails,
    replanAlertDetails,
    genreBeatAlertDetails,
    recoverableRepairDetails,
  } = input;

  if (isPipelineLeaseLostError(error)) {
    logPipelineWarn("流水线租约已丢失，另一进程已接管，本进程静默退出", {
      jobId,
      novelId,
      ownerId: host.leaseOwner ?? null,
    });
    return;
  }
  if (isPipelineCancellationError(error)) {
    await host.updateJobSafe(jobId, {
      status: "cancelled",
      error: null,
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      cancelRequestedAt: null,
      finishedAt: new Date(),
      payload: host.stringifyPipelinePayload({
        ...runtimePayload,
        qualityAlertDetails,
        replanAlertDetails,
        genreBeatAlertDetails,
        recoverableRepairDetails,
        jobTransportAutoRetryCount: 0,
      }),
    });
    void novelEventBus.emit({
      type: "pipeline:completed",
      payload: { novelId, jobId, status: "cancelled" },
    }).catch(() => {});
    return;
  }

  const message = error instanceof Error ? error.message : "流水线执行失败";
  if (isChapterEmptyContentError(error)) {
    logPipelineError("任务因章节空正文失败", {
      jobId,
      novelId,
      provider: runtimePayload.provider,
      model: runtimePayload.model,
      runMode: runtimePayload.runMode,
      workflowTaskId: runtimePayload.workflowTaskId,
      source: error.details.source,
      contentLength: error.details.trimmedLength,
      rawContentLength: error.details.rawLength,
    });
  } else if (isChapterChineseProseGateError(error)) {
    logPipelineError("任务因章节中文硬门失败", {
      jobId,
      novelId,
      provider: runtimePayload.provider,
      model: runtimePayload.model,
      runMode: runtimePayload.runMode,
      workflowTaskId: runtimePayload.workflowTaskId,
      source: error.details.source,
      reason: error.details.reason,
      metaMarker: error.details.metaMarker,
      cjkCount: error.details.cjkCount,
      latinCount: error.details.latinCount,
      rawContentLength: error.details.rawLength,
    });
  }

  const usedJobAutoRetry = normalizeJobTransportAutoRetryCount(
    runtimePayload.jobTransportAutoRetryCount,
  );
  if (shouldAutoRetryPipelineJob({
    error,
    usedCount: usedJobAutoRetry,
    maxCount: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
  })) {
    const nextCount = usedJobAutoRetry + 1;
    const retryMessage = formatPipelineJobAutoRetryMessage({
      originalMessage: message,
      nextCount,
      maxCount: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
    });
    const requeuePayload: PipelinePayload = {
      ...runtimePayload,
      qualityAlertDetails,
      replanAlertDetails,
      genreBeatAlertDetails,
      recoverableRepairDetails,
      jobTransportAutoRetryCount: nextCount,
    };
    let requeued = false;
    try {
      const result = await prisma.generationJob.updateMany({
        where: buildPipelineJobAutoRequeueCasWhere(jobId),
        data: {
          status: "queued",
          error: retryMessage,
          finishedAt: null,
          heartbeatAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          currentStage: "queued",
          currentItemKey: null,
          currentItemLabel: null,
          pendingManualRecovery: false,
          retryCount: totalRetryCount,
          payload: host.stringifyPipelinePayload(requeuePayload),
        },
      });
      requeued = result.count > 0;
    } catch (requeueError) {
      logPipelineWarn("任务自动重试写库失败", {
        jobId,
        novelId,
        error: requeueError instanceof Error ? requeueError.message : String(requeueError),
      });
    }
    if (!requeued) {
      const latest = await prisma.generationJob.findUnique({
        where: { id: jobId },
        select: { status: true, cancelRequestedAt: true },
      });
      if (latest?.cancelRequestedAt || latest?.status === "cancelled") {
        await host.updateJobSafe(jobId, {
          status: "cancelled",
          error: null,
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          cancelRequestedAt: null,
          finishedAt: new Date(),
          payload: host.stringifyPipelinePayload({
            ...runtimePayload,
            qualityAlertDetails,
            replanAlertDetails,
            genreBeatAlertDetails,
            recoverableRepairDetails,
            jobTransportAutoRetryCount: 0,
          }),
        });
        void novelEventBus.emit({
          type: "pipeline:completed",
          payload: { novelId, jobId, status: "cancelled" },
        }).catch(() => {});
        return;
      }
      if (latest?.status === "queued" || latest?.status === "succeeded" || latest?.status === "failed") {
        return;
      }
      await host.updateJobSafe(jobId, {
        status: "failed",
        error: message,
        finishedAt: new Date(),
        payload: host.stringifyPipelinePayload({
          ...runtimePayload,
          qualityAlertDetails,
          replanAlertDetails,
          genreBeatAlertDetails,
          recoverableRepairDetails,
          jobTransportAutoRetryCount: usedJobAutoRetry,
        }),
      });
      logPipelineError("任务执行异常（自动重试 CAS 未命中）", {
        jobId,
        novelId,
        message,
        jobTransportAutoRetryCount: usedJobAutoRetry,
        latestStatus: latest?.status ?? null,
      });
      void novelEventBus.emit({
        type: "pipeline:completed",
        payload: { novelId, jobId, status: "failed" },
      }).catch(() => {});
      return;
    }

    logPipelineWarn("任务瞬时失败，排队自动重试", {
      jobId,
      novelId,
      jobTransportAutoRetryCount: nextCount,
      maxCount: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
      delayMs: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS,
      recoveryPath: PIPELINE_JOB_AUTO_RETRY_RECOVERY_IN_PROCESS_TIMER,
      message,
    });
    const resumeOptions: PipelineRunOptions = {
      startOrder: options.startOrder,
      endOrder: options.endOrder,
      controlPolicy: requeuePayload.controlPolicy,
      workflowTaskId: requeuePayload.workflowTaskId,
      taskStyleProfileId: requeuePayload.taskStyleProfileId,
      maxRetries: clampPipelineMaxRetries(requeuePayload.maxRetries),
      runMode: requeuePayload.runMode,
      autoReview: requeuePayload.autoReview,
      autoRepair: requeuePayload.autoRepair,
      skipCompleted: requeuePayload.skipCompleted ?? true,
      qualityThreshold: requeuePayload.qualityThreshold,
      repairMode: requeuePayload.repairMode,
      artifactSyncMode: requeuePayload.artifactSyncMode,
      provider: requeuePayload.provider,
      model: requeuePayload.model,
      temperature: requeuePayload.temperature,
    };
    setTimeout(() => {
      host.schedulePipelineExecution(jobId, novelId, resumeOptions);
    }, PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS).unref?.();
    return;
  }

  await host.updateJobSafe(jobId, {
    status: "failed",
    error: message,
    finishedAt: new Date(),
    payload: host.stringifyPipelinePayload({
      ...runtimePayload,
      qualityAlertDetails,
      replanAlertDetails,
      genreBeatAlertDetails,
      recoverableRepairDetails,
      jobTransportAutoRetryCount: usedJobAutoRetry,
    }),
  });
  logPipelineError("任务执行异常", {
    jobId,
    novelId,
    message,
    jobTransportAutoRetryCount: usedJobAutoRetry,
  });
  void novelEventBus.emit({
    type: "pipeline:completed",
    payload: { novelId, jobId, status: "failed" },
  }).catch(() => {});
}
