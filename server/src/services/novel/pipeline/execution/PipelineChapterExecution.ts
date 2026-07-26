import type { ChapterRuntimeCoordinator } from "../../runtime/ChapterRuntimeCoordinator";
import type { PipelineRuntimeResult } from "../../runtime/chapterRuntimePipeline";
import {
  logPipelineError,
  logPipelineInfo,
  logPipelineWarn,
  type PipelinePayload,
  type PipelineRunOptions,
} from "../../novelCoreShared";
import {
  buildPipelineJobLeaseOwnedCasWhere,
  classifyNonTerminalCasMiss,
  PIPELINE_LEASE_LOST_MESSAGE,
} from "../../pipelineJobTerminalGuard";
import {
  buildPipelineCurrentItemLabel,
  buildPipelineStageProgress,
  type PipelineActiveStage,
} from "../../pipelineJobState";
import {
  buildEmptyChapterDetail,
  PIPELINE_HEARTBEAT_INTERVAL_MS,
  PIPELINE_LEASE_TTL_MS,
} from "../../pipelineExecutionHelpers";
import { prisma } from "../../../../db/prisma";

export interface PipelineExecuteHost {
  parsePipelinePayload(payload: string | null | undefined): PipelinePayload;
  stringifyPipelinePayload(input: PipelinePayload): string | null;
  updateJobSafe(jobId: string, data: Record<string, unknown>): Promise<void>;
  ensurePipelineNotCancelled(jobId: string): Promise<void>;
  schedulePipelineExecution(jobId: string, novelId: string, options: PipelineRunOptions): void;
  chapterRuntimeCoordinator: ChapterRuntimeCoordinator;
  activeChapterAborts: Map<string, AbortController>;
  leaseOwner: string | null;
}

export interface PipelineChapterRecord {
  id: string;
  order: number;
  title: string;
  content: string | null;
}

export async function executePipelineChapter(input: {
  host: PipelineExecuteHost;
  jobId: string;
  novelId: string;
  chapter: PipelineChapterRecord;
  completedCount: number;
  totalCount: number;
  maxRetries: number;
  qualityThreshold: number;
  runtimePayload: PipelinePayload;
  qualityAlertDetails: string[];
  recoverableRepairDetails: string[];
}): Promise<PipelineRuntimeResult> {
  const {
    host,
    jobId,
    novelId,
    chapter,
    completedCount,
    totalCount,
    maxRetries,
    qualityThreshold,
    runtimePayload,
    qualityAlertDetails,
    recoverableRepairDetails,
  } = input;
  await host.ensurePipelineNotCancelled(jobId);

  const currentItemLabel = buildPipelineCurrentItemLabel({
    completedCount,
    totalCount,
    chapterOrder: chapter.order,
    title: chapter.title,
  });
  let activeStage: PipelineActiveStage = "generating_chapters";
  const applyChapterStage = async (stage: PipelineActiveStage) => {
    activeStage = stage;
    const staged = await prisma.generationJob.updateMany({
      where: buildPipelineJobLeaseOwnedCasWhere(jobId, host.leaseOwner),
      data: {
        heartbeatAt: new Date(),
        currentStage: stage,
        currentItemKey: chapter.id,
        currentItemLabel,
        progress: buildPipelineStageProgress({
          completedCount,
          totalCount,
          stage,
        }),
      },
    });
    if (staged.count === 0) {
      const miss = classifyNonTerminalCasMiss(host.leaseOwner);
      throw new Error(
        miss.sentinel === "lease-lost"
          ? PIPELINE_LEASE_LOST_MESSAGE
          : "PIPELINE_CANCELLED",
      );
    }
  };

  await applyChapterStage("generating_chapters");
  logPipelineInfo("开始处理章节", {
    jobId,
    chapterId: chapter.id,
    order: chapter.order,
    hasDraft: Boolean((chapter.content ?? "").trim()),
  });

  const chapterAbort = new AbortController();
  host.activeChapterAborts.set(jobId, chapterAbort);
  const heartbeatTimer = setInterval(() => {
    void prisma.generationJob.updateMany({
      where: buildPipelineJobLeaseOwnedCasWhere(jobId, host.leaseOwner),
      data: {
        heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + PIPELINE_LEASE_TTL_MS),
        currentStage: activeStage,
        currentItemKey: chapter.id,
        currentItemLabel,
        progress: buildPipelineStageProgress({
          completedCount,
          totalCount,
          stage: activeStage,
        }),
      },
    }).then((result) => {
      if (result.count === 0 && !chapterAbort.signal.aborted) {
        chapterAbort.abort(new Error(PIPELINE_LEASE_LOST_MESSAGE));
      }
    }).catch(() => {
      // A transient heartbeat failure is retried by the next interval or caught by final CAS.
    });
    void host.ensurePipelineNotCancelled(jobId).catch((error) => {
      if (!chapterAbort.signal.aborted) {
        chapterAbort.abort(
          error instanceof Error ? error : new Error("PIPELINE_CANCELLED"),
        );
      }
    });
  }, PIPELINE_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  const chapterResult = await host.chapterRuntimeCoordinator.runPipelineChapter(
    novelId,
    chapter.id,
    {
      provider: runtimePayload.provider,
      model: runtimePayload.model,
      temperature: runtimePayload.temperature,
      taskStyleProfileId: runtimePayload.taskStyleProfileId,
      controlPolicy: runtimePayload.controlPolicy,
      maxRetries,
      autoReview: runtimePayload.autoReview,
      autoRepair: runtimePayload.autoRepair,
      qualityThreshold,
      repairMode: runtimePayload.repairMode,
      artifactSyncMode: runtimePayload.artifactSyncMode,
      runMode: runtimePayload.runMode === "polish" ? "polish" : "fast",
      signal: chapterAbort.signal,
    },
    {
      onCheckCancelled: () => host.ensurePipelineNotCancelled(jobId),
      onStageChange: applyChapterStage,
      onEmptyContent: async (event) => {
        const detail = buildEmptyChapterDetail(chapter);
        const meta = {
          jobId,
          workflowTaskId: runtimePayload.workflowTaskId,
          novelId,
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          provider: runtimePayload.provider,
          model: runtimePayload.model,
          runMode: runtimePayload.runMode,
          emptyAttempt: event.attempt,
          willRetry: event.willRetry,
          contentLength: event.contentLength,
          rawContentLength: event.rawContentLength,
          source: event.error.details.source,
        };
        if (event.willRetry) {
          logPipelineWarn("章节生成未返回正文，正在重试当前章", meta);
          return;
        }
        if (!qualityAlertDetails.includes(detail)) {
          qualityAlertDetails.push(detail);
        }
        logPipelineError("章节生成连续未返回正文，已暂停流水线", meta);
      },
      onWriterTransportRetry: async (event) => {
        const meta = {
          jobId,
          workflowTaskId: runtimePayload.workflowTaskId,
          novelId,
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          provider: runtimePayload.provider,
          model: runtimePayload.model,
          runMode: runtimePayload.runMode,
          transportAttempt: event.attempt,
          willRetry: event.willRetry,
          message: event.message,
        };
        if (event.willRetry) {
          logPipelineWarn("章节生成瞬时传输失败，正在整章重试", meta);
          return;
        }
        logPipelineError("章节生成瞬时传输失败已耗尽重试，任务将失败", meta);
      },
    },
  ).finally(() => {
    clearInterval(heartbeatTimer);
    const current = host.activeChapterAborts.get(jobId);
    if (current === chapterAbort) {
      host.activeChapterAborts.delete(jobId);
    }
  });

  if (chapterResult.recoverableRepairFailure) {
    recoverableRepairDetails.push(
      `第${chapter.order}章需要后续修复：${chapterResult.recoverableRepairFailure.message}`,
    );
    logPipelineWarn("章节局部修复未安全应用，已记录并继续后续章节", {
      jobId,
      order: chapter.order,
      reason: chapterResult.recoverableRepairFailure.message,
      failureTypes: chapterResult.recoverableRepairFailure.failureTypes,
    });
  }
  return chapterResult;
}
