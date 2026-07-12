import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import {
  buildChapterQualityLoopAssessment,
  type ChapterQualityLoopAssessment,
} from "@ai-novel/shared/types/chapterQualityLoop";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { novelEventBus } from "../../events";
import { ChapterPlanJITService } from "./planning/ChapterPlanJITService";
import { NovelVolumeService } from "./volume/NovelVolumeService";
import { runWithLlmUsageTracking } from "../../llm/usageTracking";
import { ChapterRuntimeCoordinator } from "./runtime/ChapterRuntimeCoordinator";
import { isChapterEmptyContentError } from "./runtime/chapterEmptyContentError";
import {
  logPipelineError,
  logPipelineInfo,
  logPipelineWarn,
  normalizeScore,
  type PipelinePayload,
  type PipelineRunOptions,
} from "./novelCoreShared";
import { ensureNovelCharacters } from "./novelCoreSupport";
import { createQualityReport } from "./novelCoreReviewService";
import { chapterQualityLoopService } from "./quality/ChapterQualityLoopService";
import {
  buildGenreBeatBoardSnapshot,
  buildVolumeReplanQualityDebtGate,
  formatGenreBeatShortfallPauseReason,
  GENRE_BEAT_BOARD_WINDOW_SIZE,
  shouldPauseForGenreBeatShortfall,
  type GenreBeatChapterLabelSource,
} from "./quality/qualityDebtBoard";
import { buildPipelineLeaseClaimWhere, buildStaleRecoverablePipelineJobWhere, selectPrimaryPipelineJob } from "./pipelineJobDedup";
import {
  formatPipelineJobAutoRetryMessage,
  isPipelineCancellationError,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
  shouldAutoRetryPipelineJob,
} from "./pipelineJobAutoRetry";
import { resolveUnhandledPipelineFailureTerminalUpdate } from "./pipelineJobTerminalGuard";
import { buildPipelineCurrentItemLabel, buildPipelineStageProgress, decoratePipelineJob as decoratePipelineJobRow, isPipelineActiveStage, parsePipelinePayload as parsePipelineJobPayload, stringifyPipelinePayload as stringifyPipelineJobPayload, type DecoratedPipelineJob, type PipelineActiveStage, type PipelineJobLike } from "./pipelineJobState";

export { buildPipelineCurrentItemLabel, buildPipelineStageProgress } from "./pipelineJobState";
export {
  isPipelineCancellationError,
  isPipelineJobAutoRetryableError,
  shouldAutoRetryPipelineJob,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
} from "./pipelineJobAutoRetry";

const PIPELINE_HEARTBEAT_INTERVAL_MS = 15000;
// 持久化租约 TTL：watchdog 走 180s stale 阈值，心跳 15s 一次 → TTL 取 300s（stale 阈值的
// 1.67 倍）保证活体 lease 不会被误判过期；持有者死、心跳停止后 5 分钟内 watchdog 接管。
const PIPELINE_LEASE_TTL_MS = 300_000;
const TERMINAL_CONTINUE_QUALITY_LOOP_RISK_FLAG_FRAGMENT = '"terminalAction":"defer_and_continue"';
const REPLAN_REQUIRED_QUALITY_LOOP_RISK_FLAG_FRAGMENT = '"rootCauseCode":"replan_required"';
const REPLAN_ACTION_QUALITY_LOOP_RISK_FLAG_FRAGMENT = '"recommendedAction":"replan"';

function clampPipelineMaxRetries(value: number | null | undefined): number {
  return Math.max(0, Math.min(value ?? 1, 1));
}

function buildEmptyChapterDetail(chapter: { order: number; title: string }): string {
  return `第${chapter.order}章「${chapter.title}」正文生成失败：模型连续未返回可保存正文，已暂停继续。`;
}

/** 熔断内存行：把 assessment 压成 riskFlags JSON，供 isBlockingReplanQualityDebt 读取。 */
function buildQualityLoopRiskFlagsSnapshot(
  assessment: ChapterQualityLoopAssessment,
  source: "pipeline_review" | "repair_recheck",
  terminalAction?: "defer_and_continue" | null,
): string {
  return JSON.stringify({
    qualityLoop: {
      ...assessment,
      source,
      ...(terminalAction ? { terminalAction } : {}),
    },
  });
}

function buildSkipCompletedChapterWhere(): Prisma.ChapterWhereInput {
  return {
    NOT: {
      AND: [
        { content: { not: null } },
        { content: { not: "" } },
        {
          OR: [
            { generationState: { in: ["approved", "published"] } },
            { chapterStatus: "completed" },
            {
              AND: [
                { riskFlags: { not: null } },
                { riskFlags: { contains: TERMINAL_CONTINUE_QUALITY_LOOP_RISK_FLAG_FRAGMENT } },
                { riskFlags: { not: { contains: REPLAN_REQUIRED_QUALITY_LOOP_RISK_FLAG_FRAGMENT } } },
                { riskFlags: { not: { contains: REPLAN_ACTION_QUALITY_LOOP_RISK_FLAG_FRAGMENT } } },
              ],
            },
          ],
        },
      ],
    },
  };
}

export class NovelCorePipelineService {
  private static readonly activeJobIds = new Set<string>();
  private static readonly startLocks = new Set<string>();
  /** 运行中章节的 AbortController：cancel API 可即时 abort，不必等心跳轮询 */
  private static readonly activeChapterAborts = new Map<string, AbortController>();
  private readonly chapterRuntimeCoordinator = new ChapterRuntimeCoordinator();
  private decoratePipelineJob<T extends PipelineJobLike | null>(
    job: T,
  ): T extends null ? null : DecoratedPipelineJob<Extract<T, PipelineJobLike>> {
    return (job ? decoratePipelineJobRow(job) : null) as T extends null
      ? null
      : DecoratedPipelineJob<Extract<T, PipelineJobLike>>;
  }

  private buildRangeKey(novelId: string, startOrder: number, endOrder: number): string {
    return `${novelId}:${startOrder}:${endOrder}`;
  }

  private async waitForStartLock(key: string): Promise<void> {
    while (NovelCorePipelineService.startLocks.has(key)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async withStartLock<T>(key: string, runner: () => Promise<T>): Promise<T> {
    await this.waitForStartLock(key);
    NovelCorePipelineService.startLocks.add(key);
    try {
      return await runner();
    } finally {
      NovelCorePipelineService.startLocks.delete(key);
    }
  }

  private async listActivePipelineJobsForRange(novelId: string, startOrder: number, endOrder: number) {
    return prisma.generationJob.findMany({
      where: {
        novelId,
        startOrder,
        endOrder,
        status: { in: ["queued", "running"] },
        pendingManualRecovery: false,
      },
      orderBy: [
        { completedCount: "desc" },
        { progress: "desc" },
        { updatedAt: "desc" },
        { createdAt: "asc" },
      ],
    });
  }

  private async reconcileActivePipelineJobsForRange(input: {
    novelId: string;
    startOrder: number;
    endOrder: number;
    preferredJobId?: string | null;
  }) {
    const jobs = await this.listActivePipelineJobsForRange(input.novelId, input.startOrder, input.endOrder);
    if (jobs.length === 0) {
      return null;
    }

    const primaryJob = selectPrimaryPipelineJob(jobs, input.preferredJobId);
    const duplicateJobs = jobs.filter((job) => job.id !== primaryJob.id);

    if (duplicateJobs.length > 0) {
      const cancelledAt = new Date();
      await prisma.generationJob.updateMany({
        where: {
          id: { in: duplicateJobs.map((job) => job.id) },
          status: { in: ["queued", "running"] },
        },
        data: {
          status: "cancelled",
          error: `检测到同一本书相同章节区间存在重复流水线，已切换为主任务 ${primaryJob.id}。`,
          cancelRequestedAt: cancelledAt,
          heartbeatAt: cancelledAt,
          finishedAt: cancelledAt,
        },
      });
      logPipelineWarn("发现重复活跃批量任务，已取消重复项", {
        novelId: input.novelId,
        range: `${input.startOrder}-${input.endOrder}`,
        primaryJobId: primaryJob.id,
        cancelledJobIds: duplicateJobs.map((job) => job.id),
      });
    }

    return primaryJob;
  }

  async findActivePipelineJobForRange(
    novelId: string,
    startOrder: number,
    endOrder: number,
    preferredJobId?: string | null,
  ) {
    return this.reconcileActivePipelineJobsForRange({
      novelId,
      startOrder,
      endOrder,
      preferredJobId,
    });
  }

  async listRecoverablePipelineJobs(): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.generationJob.findMany({
      where: {
        status: { in: ["queued", "running"] },
        pendingManualRecovery: false,
        finishedAt: null,
        cancelRequestedAt: null,
      },
      select: {
        id: true,
        status: true,
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
    }));
  }

  async listPendingCancellationPipelineJobs(): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.generationJob.findMany({
      where: {
        finishedAt: null,
        cancelRequestedAt: { not: null },
      },
      select: {
        id: true,
        status: true,
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
    }));
  }

  async listStaleRecoverablePipelineJobs(cutoff: Date, now: Date = new Date()): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.generationJob.findMany({
      where: buildStaleRecoverablePipelineJobWhere({ cutoff, now }),
      select: {
        id: true,
        status: true,
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
    }));
  }

  async markPipelineJobFailed(jobId: string, message: string): Promise<void> {
    await this.updateJobSafe(jobId, {
      status: "failed",
      error: message.trim(),
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      cancelRequestedAt: null,
      finishedAt: new Date(),
    });
  }

  async markPipelineJobCancelled(jobId: string): Promise<void> {
    await this.updateJobSafe(jobId, {
      status: "cancelled",
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      cancelRequestedAt: null,
      finishedAt: new Date(),
    });
  }

  async markPipelineJobPendingManualRecovery(jobId: string, message: string): Promise<void> {
    await this.updateJobSafe(jobId, {
      status: "queued",
      error: message.trim(),
      pendingManualRecovery: true,
      heartbeatAt: null,
      currentStage: "queued",
      currentItemKey: null,
      currentItemLabel: null,
      cancelRequestedAt: null,
      finishedAt: null,
    });
  }

  async resumePipelineJob(jobId: string): Promise<void> {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        novelId: true,
        status: true,
        startOrder: true,
        endOrder: true,
        runMode: true,
        autoReview: true,
        autoRepair: true,
        skipCompleted: true,
        qualityThreshold: true,
        repairMode: true,
        maxRetries: true,
        payload: true,
      },
    });
    if (!job) {
      throw new Error("章节流水线任务不存在。");
    }
      if (job.status !== "queued" && job.status !== "running") {
        return;
      }
      await this.updateJobSafe(job.id, {
        status: "queued",
        pendingManualRecovery: false,
        heartbeatAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        cancelRequestedAt: null,
      });
      const payload = this.parsePipelinePayload(job.payload);
      this.schedulePipelineExecution(job.id, job.novelId, {
        startOrder: job.startOrder,
        endOrder: job.endOrder,
        controlPolicy: payload.controlPolicy,
        workflowTaskId: payload.workflowTaskId,
        taskStyleProfileId: payload.taskStyleProfileId,
        maxRetries: clampPipelineMaxRetries(job.maxRetries),
        runMode: job.runMode ?? payload.runMode,
        autoReview: job.autoReview ?? payload.autoReview,
        autoRepair: job.autoRepair ?? payload.autoRepair,
        skipCompleted: job.skipCompleted ?? payload.skipCompleted,
        qualityThreshold: job.qualityThreshold ?? payload.qualityThreshold,
        repairMode: job.repairMode ?? payload.repairMode,
        artifactSyncMode: payload.artifactSyncMode,
        provider: payload.provider,
        model: payload.model,
        temperature: payload.temperature,
      });
  }

  async startPipelineJob(novelId: string, options: PipelineRunOptions) {
    const rangeKey = this.buildRangeKey(novelId, options.startOrder, options.endOrder);
    return this.withStartLock(rangeKey, async () => {
      const maxRetries = clampPipelineMaxRetries(options.maxRetries);
      const runtimeOptions: PipelineRunOptions = { ...options, maxRetries };
      await ensureNovelCharacters(novelId, "启动批量章节流水");

      const existingActiveJob = await this.reconcileActivePipelineJobsForRange({
        novelId,
        startOrder: options.startOrder,
        endOrder: options.endOrder,
      });
      if (existingActiveJob) {
        logPipelineWarn("检测到同区间已有活跃批量任务，复用现有任务", {
          novelId,
          range: `${options.startOrder}-${options.endOrder}`,
          reusedJobId: existingActiveJob.id,
        });
        this.schedulePipelineExecution(existingActiveJob.id, novelId, runtimeOptions);
        return this.decoratePipelineJob(existingActiveJob);
      }

      const chapterStats = await prisma.chapter.aggregate({
        where: { novelId },
        _min: { order: true },
        _max: { order: true },
        _count: { order: true },
      });
      if ((chapterStats._count.order ?? 0) === 0) {
        throw new Error("当前小说还没有章节，请先创建章节后再启动流水线。");
      }

      const chapters = await prisma.chapter.findMany({
        where: {
          novelId,
          order: { gte: options.startOrder, lte: options.endOrder },
          ...(options.skipCompleted
            ? buildSkipCompletedChapterWhere()
            : {}),
        },
        orderBy: { order: "asc" },
        select: { id: true },
      });
      if (chapters.length === 0) {
        const minOrder = chapterStats._min.order ?? 1;
        const maxOrder = chapterStats._max.order ?? 1;
        throw new Error(`指定区间内没有可生成的章节。当前可用章节范围为第 ${minOrder} 章到第 ${maxOrder} 章。`);
      }

      logPipelineInfo("创建批量任务", {
        novelId,
        range: `${options.startOrder}-${options.endOrder}`,
        matchedChapters: chapters.length,
        availableRange: `${chapterStats._min.order ?? 1}-${chapterStats._max.order ?? 1}`,
        maxRetries,
        provider: options.provider,
        model: options.model,
      });

      const job = await prisma.generationJob.create({
        data: {
          novelId,
          startOrder: options.startOrder,
          endOrder: options.endOrder,
          runMode: options.runMode ?? "fast",
          autoReview: options.autoReview ?? true,
          autoRepair: options.autoRepair ?? true,
          skipCompleted: options.skipCompleted ?? true,
          qualityThreshold: options.qualityThreshold ?? null,
          repairMode: options.repairMode ?? "light_repair",
          status: "queued",
          pendingManualRecovery: false,
          totalCount: chapters.length,
          maxRetries,
          currentStage: "queued",
          payload: this.stringifyPipelinePayload({
            provider: options.provider,
            model: options.model,
            temperature: options.temperature ?? 0.8,
            controlPolicy: options.controlPolicy,
            workflowTaskId: options.workflowTaskId?.trim() || undefined,
            taskStyleProfileId: options.taskStyleProfileId?.trim() || undefined,
            maxRetries,
            runMode: options.runMode ?? "fast",
            autoReview: options.autoReview ?? true,
            autoRepair: options.autoRepair ?? true,
            skipCompleted: options.skipCompleted ?? true,
            qualityThreshold: options.qualityThreshold,
            repairMode: options.repairMode ?? "light_repair",
            artifactSyncMode: options.artifactSyncMode ?? "adaptive",
          }),
        },
      });

      logPipelineInfo("批量任务已入队", {
        jobId: job.id,
        novelId,
        totalCount: job.totalCount,
      });

      this.schedulePipelineExecution(job.id, novelId, runtimeOptions);
      return this.decoratePipelineJob(job);
    });
  }

  async getPipelineJob(novelId: string, jobId: string) {
    const job = await prisma.generationJob.findFirst({ where: { id: jobId, novelId } });
    return job ? this.decoratePipelineJob(job) : null;
  }

  async getPipelineJobById(jobId: string) {
    const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
    return job ? this.decoratePipelineJob(job) : null;
  }

  async retryPipelineJob(jobId: string) {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new Error("任务不存在。");
    }
    if (job.status !== "failed" && job.status !== "cancelled") {
      throw new Error("仅失败或已取消的任务支持重试。");
    }
    if (job.status === "cancelled" && job.cancelRequestedAt && !job.finishedAt) {
      throw new Error("任务仍在取消中，请等待取消完成后再重试。");
    }

    const payload = this.parsePipelinePayload(job.payload);
    return this.startPipelineJob(job.novelId, {
      startOrder: job.startOrder,
      endOrder: job.endOrder,
      workflowTaskId: payload.workflowTaskId,
      taskStyleProfileId: payload.taskStyleProfileId,
      maxRetries: clampPipelineMaxRetries(job.maxRetries),
      runMode: job.runMode ?? payload.runMode,
      autoReview: job.autoReview ?? payload.autoReview,
      autoRepair: job.autoRepair ?? payload.autoRepair,
      skipCompleted: job.skipCompleted ?? payload.skipCompleted,
      qualityThreshold: job.qualityThreshold ?? payload.qualityThreshold,
      repairMode: job.repairMode ?? payload.repairMode,
      artifactSyncMode: payload.artifactSyncMode,
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
    });
  }

  async cancelPipelineJob(jobId: string) {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new Error("任务不存在。");
    }
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      throw new Error("仅排队中或运行中的任务可取消。");
    }
    // 即时穿透：本进程内正在生成的章节立刻 abort LLM/stream，不依赖 15s 心跳
    const liveAbort = NovelCorePipelineService.activeChapterAborts.get(jobId);
    if (liveAbort && !liveAbort.signal.aborted) {
      liveAbort.abort(new Error("PIPELINE_CANCELLED"));
    }
    if (job.status === "queued") {
      return prisma.generationJob.update({
        where: { id: jobId },
        data: {
          status: "cancelled",
          cancelRequestedAt: null,
          heartbeatAt: null,
          error: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          finishedAt: new Date(),
        },
      });
    }
    return prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: "cancelled",
        cancelRequestedAt: new Date(),
        heartbeatAt: new Date(),
        finishedAt: null,
      },
    });
  }

  private parsePipelinePayload(payload: string | null | undefined) {
    return parsePipelineJobPayload(payload);
  }

  private stringifyPipelinePayload(input: PipelinePayload) {
    return stringifyPipelineJobPayload(input);
  }

  private async ensurePipelineNotCancelled(jobId: string): Promise<void> {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        cancelRequestedAt: true,
      },
    });
    if (!job || job.status === "cancelled" || job.cancelRequestedAt) {
      throw new Error("PIPELINE_CANCELLED");
    }
  }

  private async updateJobSafe(jobId: string, data: {
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    progress?: number;
    completedCount?: number;
    retryCount?: number;
    pendingManualRecovery?: boolean;
    heartbeatAt?: Date | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    currentStage?: string | null;
    currentItemKey?: string | null;
    currentItemLabel?: string | null;
    cancelRequestedAt?: Date | null;
    error?: string | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    payload?: string | null;
  }) {
    const isTerminal = data.status === "succeeded"
      || data.status === "failed"
      || data.status === "cancelled";
    const maxAttempts = isTerminal ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await prisma.generationJob.update({
          where: { id: jobId },
          data,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          continue;
        }
      }
    }
    logPipelineWarn("流水线任务状态写库失败", {
      jobId,
      status: data.status ?? null,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  /**
   * 调度层兜底：executePipeline 在内层 try 之外抛错时，仍保证 job 离开 running。
   * 已是 succeeded/failed/cancelled/queued（含 auto-requeue）则不覆盖。
   */
  private async ensurePipelineJobTerminalAfterUnhandledError(jobId: string, error: unknown): Promise<void> {
    try {
      const job = await prisma.generationJob.findUnique({
        where: { id: jobId },
        select: {
          status: true,
          cancelRequestedAt: true,
        },
      });
      const terminal = resolveUnhandledPipelineFailureTerminalUpdate({
        status: job?.status,
        cancelRequestedAt: job?.cancelRequestedAt ?? null,
        error,
      });
      if (!terminal) {
        return;
      }
      await this.updateJobSafe(jobId, {
        status: terminal.status,
        error: terminal.error,
        finishedAt: new Date(),
        heartbeatAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        cancelRequestedAt: terminal.status === "cancelled" ? null : undefined,
      });
      logPipelineWarn("流水线调度兜底写入终态", {
        jobId,
        status: terminal.status,
        error: terminal.error,
      });
    } catch (guardError) {
      logPipelineWarn("流水线调度兜底终态写库失败", {
        jobId,
        error: guardError instanceof Error ? guardError.message : String(guardError),
        original: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private schedulePipelineExecution(jobId: string, novelId: string, options: PipelineRunOptions): void {
    if (NovelCorePipelineService.activeJobIds.has(jobId)) {
      return;
    }
    NovelCorePipelineService.activeJobIds.add(jobId);
    void (async () => {
      // CAS 认领：消除"两个进程同时调度同 jobId"的竞态——内存 activeJobIds 只能防本进程内
      // 重复 dispatch，跨进程（respawn 后新实例 + 旧实例残留）dedup 必须落 DB。leaseExpiresAt
      // null 或已过期才能认领；认领成功后其它实例 updateMany 看到 status=running 且 lease
      // 未过期，count=0 → 跳过。env GENERATION_JOB_LEASE_ENABLED=false 回退到内存去重路径
      // （只保留 activeJobIds，不做 DB CAS）——留给线上 hot-fix 回退用。
      const leaseEnabled = process.env.GENERATION_JOB_LEASE_ENABLED !== "false";
      if (leaseEnabled) {
        try {
          const claimed = await prisma.generationJob.updateMany({
            where: buildPipelineLeaseClaimWhere({ jobId, now: new Date() }),
            data: {
              status: "running",
              // 清掉 auto-requeue 残留的 error，避免 running 期间仍展示失败文案
              error: null,
              leaseOwner: `pipeline-${process.pid}`,
              leaseExpiresAt: new Date(Date.now() + PIPELINE_LEASE_TTL_MS),
            },
          });
          if (claimed.count === 0) {
            // 已被其它实例认领或租约未过期——不重复调度。
            NovelCorePipelineService.activeJobIds.delete(jobId);
            return;
          }
        } catch (error) {
          // 认领异常：不静默双跑。仅本进程 activeJobIds 不足以防跨进程竞态。
          logPipelineWarn("流水线租约认领失败，跳过本次调度", {
            jobId,
            novelId,
            error: error instanceof Error ? error.message : String(error),
          });
          NovelCorePipelineService.activeJobIds.delete(jobId);
          return;
        }
      }
      await this.executePipeline(jobId, novelId, options)
        .catch(async (error) => {
          // 防止未处理 rejection 拖垮进程；并保证 job 不永久卡在 running。
          await this.ensurePipelineJobTerminalAfterUnhandledError(jobId, error);
        })
        .finally(() => {
          NovelCorePipelineService.activeJobIds.delete(jobId);
        });
    })();
  }

  private async executePipeline(jobId: string, novelId: string, options: PipelineRunOptions) {
    const maxRetries = clampPipelineMaxRetries(options.maxRetries);
    const qualityThreshold = options.qualityThreshold ?? 75;
    const existingJob = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        startedAt: true,
        completedCount: true,
        totalCount: true,
        retryCount: true,
        payload: true,
      },
    });
    const persistedPayload = this.parsePipelinePayload(existingJob?.payload);
    const runtimePayload: PipelinePayload = {
      provider: persistedPayload.provider ?? options.provider,
      model: persistedPayload.model ?? options.model,
      temperature: persistedPayload.temperature ?? options.temperature ?? 0.8,
      controlPolicy: persistedPayload.controlPolicy ?? options.controlPolicy,
      workflowTaskId: persistedPayload.workflowTaskId ?? options.workflowTaskId,
      taskStyleProfileId: persistedPayload.taskStyleProfileId ?? options.taskStyleProfileId,
      maxRetries: clampPipelineMaxRetries(persistedPayload.maxRetries ?? options.maxRetries),
      runMode: persistedPayload.runMode ?? options.runMode ?? "fast",
      autoReview: persistedPayload.autoReview ?? options.autoReview ?? true,
      autoRepair: persistedPayload.autoRepair ?? options.autoRepair ?? true,
      skipCompleted: persistedPayload.skipCompleted ?? options.skipCompleted ?? true,
      qualityThreshold: persistedPayload.qualityThreshold ?? options.qualityThreshold,
      repairMode: persistedPayload.repairMode ?? options.repairMode ?? "light_repair",
      artifactSyncMode: persistedPayload.artifactSyncMode ?? options.artifactSyncMode ?? "adaptive",
      jobTransportAutoRetryCount: Math.max(0, persistedPayload.jobTransportAutoRetryCount ?? 0),
    };
    const directorTelemetryTask = runtimePayload.workflowTaskId
      ? await prisma.novelWorkflowTask.findUnique({
        where: { id: runtimePayload.workflowTaskId },
        select: {
          lane: true,
          directorRun: {
            select: { id: true },
          },
        },
      }).catch(() => null)
      : null;
    const shouldRecordDirectorTelemetry = directorTelemetryTask?.lane === "auto_director";
    let totalRetryCount = Math.max(existingJob?.retryCount ?? 0, 0);
    const qualityAlertDetails = [...(persistedPayload.qualityAlertDetails ?? [])];
    const replanAlertDetails = [...(persistedPayload.replanAlertDetails ?? [])];
    const genreBeatAlertDetails = [...(persistedPayload.genreBeatAlertDetails ?? [])];
    const recoverableRepairDetails = [...(persistedPayload.recoverableRepairDetails ?? [])];

    try {
      await runWithLlmUsageTracking({
        generationJobId: jobId,
        workflowTaskId: runtimePayload.workflowTaskId,
        directorTelemetry: shouldRecordDirectorTelemetry,
        novelId: shouldRecordDirectorTelemetry ? novelId : null,
        directorRunId: shouldRecordDirectorTelemetry
          ? directorTelemetryTask?.directorRun?.id ?? runtimePayload.workflowTaskId ?? null
          : null,
      }, async () => {
        await this.updateJobSafe(jobId, {
          status: "running",
          error: null,
          pendingManualRecovery: false,
          startedAt: existingJob?.startedAt ?? new Date(),
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + PIPELINE_LEASE_TTL_MS),
          currentStage: "generating_chapters",
        });
        logPipelineInfo("任务开始执行", {
          jobId,
          novelId,
          range: `${options.startOrder}-${options.endOrder}`,
          maxRetries,
        });

        const [novel, chapters] = await Promise.all([
          prisma.novel.findUnique({ where: { id: novelId } }),
          prisma.chapter.findMany({
            where: {
              novelId,
              order: { gte: options.startOrder, lte: options.endOrder },
              ...(options.skipCompleted
                ? buildSkipCompletedChapterWhere()
                : {}),
            },
            orderBy: { order: "asc" },
          }),
        ]);
        if (!novel) {
          throw new Error("任务执行失败：小说或章节不存在");
        }
        if (chapters.length === 0) {
          // 任务创建后异步执行期间，区间内章节可能已被审稿/质量循环标记为完成或 defer_and_continue，
          // 被 skipCompleted 过滤为空。这不是硬故障——抛与创建路径一致的 sentinel，让导演自动执行
          // 的 isNoChaptersToGenerateError 兜底识别并推进 range，而非把任务卡在 failed。
          const stats = await prisma.chapter.aggregate({
            where: { novelId },
            _min: { order: true },
            _max: { order: true },
          });
          const minOrder = stats._min.order ?? 1;
          const maxOrder = stats._max.order ?? 1;
          throw new Error(`指定区间内没有可生成的章节。当前可用章节范围为第 ${minOrder} 章到第 ${maxOrder} 章。`);
        }

        logPipelineInfo("任务加载完成", {
          jobId,
          novelId,
          title: novel.title,
          chapterCount: chapters.length,
        });

        const totalCount = Math.max(existingJob?.totalCount ?? 0, chapters.length, 1);
        const storedCompleted = Math.min(Math.max(existingJob?.completedCount ?? 0, 0), totalCount);
        const filteredCompletedCount = runtimePayload.skipCompleted
          ? Math.max(0, totalCount - chapters.length)
          : 0;
        const remainingStartIndex = Math.min(
          Math.max(0, storedCompleted - filteredCompletedCount),
          chapters.length,
        );
        let completed = storedCompleted;
        const chaptersToProcess = chapters.slice(remainingStartIndex);

        // job 运行范围 replan 质量债：启动时 seed 一次，章内只更新内存，避免每章扫库。
        // 覆盖整段 options.startOrder–endOrder（含 skipCompleted 过滤掉的历史章）。
        const rangeDebtRows = await prisma.chapter.findMany({
          where: {
            novelId,
            order: { gte: options.startOrder, lte: options.endOrder },
          },
          select: { id: true, order: true, riskFlags: true },
          orderBy: { order: "asc" },
        });
        const rangeDebtByChapterId = new Map(
          rangeDebtRows.map((row) => [row.id, { order: row.order, riskFlags: row.riskFlags }]),
        );
        const evaluateRangeReplanGate = () =>
          buildVolumeReplanQualityDebtGate({
            chapters: Array.from(rangeDebtByChapterId.values()),
            startOrder: options.startOrder,
            endOrder: options.endOrder,
          });

        // 品类主配额（前 N 章满窗 shortfall）熔断：启动 seed；窗内章完成后从 DB 重读 title/taskSheet/summary。
        // 未满窗只观测不熔断；sceneDiversity.recommendForce 永不触发本门。
        // 原因写入 genreBeatAlertDetails（≠ replanAlertDetails），notice=PIPELINE_GENRE_BEAT_SHORTFALL。
        const genreBeatWindowSize = GENRE_BEAT_BOARD_WINDOW_SIZE;
        const genreBeatFraming = {
          sellingPoint: novel.bookSellingPoint ?? null,
          competingFeel: novel.competingFeel ?? null,
          first30ChapterPromise: novel.first30ChapterPromise ?? null,
        };
        const genreBeatLabelSelect = {
          id: true,
          order: true,
          title: true,
          taskSheet: true,
          chapterSummary: { select: { summary: true } },
        } as const;
        const mapGenreBeatLabelRow = (row: {
          id: string;
          order: number;
          title: string | null;
          taskSheet: string | null;
          chapterSummary: { summary: string | null } | null;
        }): GenreBeatChapterLabelSource & { id: string } => ({
          id: row.id,
          order: row.order,
          title: row.title,
          taskSheet: row.taskSheet,
          summary: row.chapterSummary?.summary ?? null,
        });
        const genreBeatSeedRows = await prisma.chapter.findMany({
          where: {
            novelId,
            order: { lte: genreBeatWindowSize },
          },
          orderBy: { order: "asc" },
          take: genreBeatWindowSize,
          select: genreBeatLabelSelect,
        });
        const genreBeatByChapterId = new Map<string, GenreBeatChapterLabelSource & { id: string }>(
          genreBeatSeedRows.map((row) => [row.id, mapGenreBeatLabelRow(row)]),
        );
        const evaluateGenreBeatGate = () => {
          const snapshot = buildGenreBeatBoardSnapshot({
            framing: genreBeatFraming,
            chapters: Array.from(genreBeatByChapterId.values()),
            windowSize: genreBeatWindowSize,
          });
          return {
            snapshot,
            shouldPause: shouldPauseForGenreBeatShortfall(snapshot),
          };
        };
        const refreshGenreBeatLabelFromDb = async (chapterId: string, chapterOrder: number) => {
          if (chapterOrder > genreBeatWindowSize) {
            return;
          }
          const row = await prisma.chapter.findUnique({
            where: { id: chapterId },
            select: genreBeatLabelSelect,
          });
          if (!row) {
            return;
          }
          genreBeatByChapterId.set(row.id, mapGenreBeatLabelRow(row));
        };
        const recordGenreBeatPause = (snapshot: ReturnType<typeof buildGenreBeatBoardSnapshot>, lastChapterOrder?: number | null) => {
          const detail = formatGenreBeatShortfallPauseReason(snapshot, {
            lastChapterOrder: lastChapterOrder ?? null,
          });
          if (!genreBeatAlertDetails.includes(detail)) {
            genreBeatAlertDetails.push(detail);
          }
          logPipelineWarn("品类主配额满窗 shortfall 熔断，停止后续章节流水线", {
            jobId,
            order: lastChapterOrder ?? null,
            windowSize: snapshot.coverage.windowSize,
            labeledChapterCount: snapshot.coverage.labeledChapterCount,
            meetsPrimaryQuota: snapshot.coverage.meetsPrimaryQuota,
            shortfalls: snapshot.coverage.shortfalls,
          });
        };

        // Phase 3：JIT 预取服务（N+1 章执行预取）
        const prefetchVolumeService = new NovelVolumeService();
        const prefetchJITService = new ChapterPlanJITService({
          ensureChapterExecutionContract: (nId, cId, opts) =>
            prefetchVolumeService.ensureChapterExecutionContract(nId, cId, opts),
        });
        const isAutopilotMode = runtimePayload.controlPolicy?.advanceMode === "full_book_autopilot";

        // 进环前：窗已 complete 且 primary shortfall 时直接停，避免 startOrder>window 时再白写一章。
        {
          const genreGateBeforeLoop = evaluateGenreBeatGate();
          if (genreGateBeforeLoop.shouldPause) {
            recordGenreBeatPause(genreGateBeforeLoop.snapshot, null);
            const finalStatus: "succeeded" = "succeeded";
            await this.updateJobSafe(jobId, {
              status: finalStatus,
              error: null,
              heartbeatAt: null,
              currentStage: null,
              currentItemKey: null,
              currentItemLabel: null,
              cancelRequestedAt: null,
              finishedAt: new Date(),
              payload: this.stringifyPipelinePayload({
                ...runtimePayload,
                qualityAlertDetails,
                replanAlertDetails,
                genreBeatAlertDetails,
                recoverableRepairDetails,
                // 终态清零：避免成功/熔断暂停后 UI 仍显示瞬时重试预算
                jobTransportAutoRetryCount: 0,
              }),
            });
            logPipelineInfo("任务执行结束", {
              jobId,
              status: finalStatus,
              qualityAlertCount: qualityAlertDetails.length,
              genreBeatAlertCount: genreBeatAlertDetails.length,
              stopReason: "genre_beat_shortfall_before_loop",
            });
            void novelEventBus.emit({
              type: "pipeline:completed",
              payload: { novelId, jobId, status: finalStatus },
            }).catch(() => {});
            return;
          }
        }

        for (let chapterIndex = 0; chapterIndex < chaptersToProcess.length; chapterIndex++) {
          const chapter = chaptersToProcess[chapterIndex];
          await this.ensurePipelineNotCancelled(jobId);

          let final = { score: normalizeScore({}), issues: [] as ReviewIssue[] };
          let shouldStopAfterCurrentChapter = false;
          const currentItemLabel = buildPipelineCurrentItemLabel({
            completedCount: completed,
            totalCount,
            chapterOrder: chapter.order,
            title: chapter.title,
          });
          let activeStage: PipelineActiveStage = "generating_chapters";
          const applyChapterStage = async (stage: PipelineActiveStage) => {
            activeStage = stage;
            await this.updateJobSafe(jobId, {
              heartbeatAt: new Date(),
              currentStage: stage,
              currentItemKey: chapter.id,
              currentItemLabel,
              progress: buildPipelineStageProgress({
                completedCount: completed,
                totalCount,
                stage,
              }),
            });
          };

          await applyChapterStage("generating_chapters");
          logPipelineInfo("开始处理章节", {
            jobId,
            chapterId: chapter.id,
            order: chapter.order,
            hasDraft: Boolean((chapter.content ?? "").trim()),
          });

          const chapterAbort = new AbortController();
          NovelCorePipelineService.activeChapterAborts.set(jobId, chapterAbort);
          const heartbeatTimer = setInterval(() => {
            void this.updateJobSafe(jobId, {
              heartbeatAt: new Date(),
              leaseExpiresAt: new Date(Date.now() + PIPELINE_LEASE_TTL_MS),
              currentStage: activeStage,
              currentItemKey: chapter.id,
              currentItemLabel,
              progress: buildPipelineStageProgress({
                completedCount: completed,
                totalCount,
                stage: activeStage,
              }),
            });
            // 心跳间隙轮询取消（跨进程/无 live map 时的兜底）
            void this.ensurePipelineNotCancelled(jobId).catch((error) => {
              if (!chapterAbort.signal.aborted) {
                chapterAbort.abort(
                  error instanceof Error ? error : new Error("PIPELINE_CANCELLED"),
                );
              }
            });
          }, PIPELINE_HEARTBEAT_INTERVAL_MS);
          heartbeatTimer.unref?.();

          const chapterResult = await this.chapterRuntimeCoordinator.runPipelineChapter(
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
              signal: chapterAbort.signal,
            },
            {
              onCheckCancelled: () => this.ensurePipelineNotCancelled(jobId),
              onStageChange: async (stage) => {
                await applyChapterStage(stage);
              },
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
            const current = NovelCorePipelineService.activeChapterAborts.get(jobId);
            if (current === chapterAbort) {
              NovelCorePipelineService.activeChapterAborts.delete(jobId);
            }
          });

          totalRetryCount += chapterResult.retryCountUsed;
          final = { score: chapterResult.score, issues: chapterResult.issues };
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
          if (chapterResult.reviewExecuted) {
            await createQualityReport(novelId, chapter.id, final.score, final.issues);
            const assessmentSource = chapterResult.retryCountUsed > 0 ? "repair_recheck" : "pipeline_review";
            const assessmentTerminalAction = chapterResult.pass ? null : "defer_and_continue";
            // 先构建 assessment 供 fail-open 内存并计；DB 成功后再以同源结果更新。
            const memoryAssessment = buildChapterQualityLoopAssessment({
              chapterId: chapter.id,
              chapterOrder: chapter.order,
              score: final.score,
              issues: final.issues,
              runtimePackage: chapterResult.runtimePackage,
            });
            let assessmentForMemory: ChapterQualityLoopAssessment = memoryAssessment;
            try {
              assessmentForMemory = await chapterQualityLoopService.recordAssessment({
                novelId,
                chapterId: chapter.id,
                chapterOrder: chapter.order,
                score: final.score,
                issues: final.issues,
                runtimePackage: chapterResult.runtimePackage,
                source: assessmentSource,
                terminalAction: assessmentTerminalAction,
                taskId: runtimePayload.workflowTaskId,
                qualityDebtAttribution: chapterResult.qualityDebtAttribution ?? null,
              });
            } catch (error) {
              logPipelineError("记录章节质量闭环状态失败", {
                jobId,
                novelId,
                chapterId: chapter.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            rangeDebtByChapterId.set(chapter.id, {
              order: chapter.order,
              riskFlags: buildQualityLoopRiskFlagsSnapshot(
                assessmentForMemory,
                assessmentSource,
                assessmentTerminalAction,
              ),
            });
          }

          if (chapterResult.reviewExecuted && !chapterResult.pass) {
            qualityAlertDetails.push(
              `第${chapter.order}章（coherence=${final.score.coherence}, repetition=${final.score.repetition}, engagement=${final.score.engagement}）`,
            );
            logPipelineWarn("章节最终未达标", {
              jobId,
              order: chapter.order,
              score: final.score,
            });
          }

          const replanRecommendation = chapterResult.runtimePackage?.replanRecommendation;
          if (replanRecommendation?.recommended) {
            const impactedOrders = replanRecommendation.affectedChapterOrders?.length
              ? `影响章节=${replanRecommendation.affectedChapterOrders.join(",")}`
              : `锚点章节=${replanRecommendation.anchorChapterOrder ?? chapter.order}`;
            const detail = `第${chapter.order}章${replanRecommendation.action === "stop_for_replan" ? "需要重规划" : "建议局部处理"}（${impactedOrders}；原因=${replanRecommendation.triggerReason ?? replanRecommendation.reason}）`;
            if (replanRecommendation.action === "stop_for_replan") {
              replanAlertDetails.push(detail);
              shouldStopAfterCurrentChapter = true;
            } else if (!qualityAlertDetails.includes(detail)) {
              qualityAlertDetails.push(detail);
            }
          }

          // 窗内章：从 DB 重读 title/taskSheet/summary（禁止用 job 启动时的 chapter 快照覆盖）。
          await refreshGenreBeatLabelFromDb(chapter.id, chapter.order);

          // job 运行范围 replan 质量债熔断：内存计数达阈值则停止后续章（不每章扫库）。
          if (!shouldStopAfterCurrentChapter) {
            const volumeGate = evaluateRangeReplanGate();
            if (volumeGate.shouldPause) {
              const detail = volumeGate.reason ?? "运行范围内 replan 质量债已达熔断阈值。";
              if (!replanAlertDetails.includes(detail)) {
                replanAlertDetails.push(detail);
              }
              shouldStopAfterCurrentChapter = true;
              logPipelineWarn("运行范围 replan 质量债熔断，停止后续章节流水线", {
                jobId,
                order: chapter.order,
                blockingReplanCount: volumeGate.blockingReplanCount,
                threshold: volumeGate.threshold,
                scope: volumeGate.scope,
                startOrder: volumeGate.startOrder,
                endOrder: volumeGate.endOrder,
              });
            }
          }

          // 品类主配额满窗 shortfall 熔断（与 replan gate / diversity soft-force 解耦）。
          // 原因进 genreBeatAlertDetails，不进 replanAlertDetails。
          if (!shouldStopAfterCurrentChapter) {
            const genreGate = evaluateGenreBeatGate();
            if (genreGate.shouldPause) {
              recordGenreBeatPause(genreGate.snapshot, chapter.order);
              shouldStopAfterCurrentChapter = true;
            }
          }

          // Phase 3：N+1 章 JIT 预取
          // 当前章 finalize 完成后（factLedger 已写入），后台触发下一章的 task sheet 生成。
          // fire-and-forget：预取失败不影响当前流水线，下一章正式组装时会重试。
          const nextChapter = chaptersToProcess[chapterIndex + 1];
          if (nextChapter && isAutopilotMode) {
            void prefetchJITService.ensureExecutionReady(novelId, nextChapter.id).catch((error) => {
              logPipelineInfo("N+1 JIT 预取失败（非阻断，下一章将在组装时重试）", {
                jobId,
                nextChapterId: nextChapter.id,
                nextChapterOrder: nextChapter.order,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }

          completed += 1;
          await this.updateJobSafe(jobId, {
            completedCount: completed,
            progress: Number((completed / totalCount).toFixed(4)),
            retryCount: totalRetryCount,
            heartbeatAt: new Date(),
            payload: this.stringifyPipelinePayload({
              ...runtimePayload,
              qualityAlertDetails,
              replanAlertDetails,
              genreBeatAlertDetails,
              recoverableRepairDetails,
            }),
          });
          logPipelineInfo("任务进度更新", {
            jobId,
            completed,
            total: totalCount,
            progress: Number((completed / totalCount).toFixed(4)),
            retryCount: totalRetryCount,
          });
          if (shouldStopAfterCurrentChapter) {
            logPipelineWarn("章节触发熔断，已停止后续章节流水线", {
              jobId,
              order: chapter.order,
              remaining: Math.max(0, totalCount - completed),
              replanAlertCount: replanAlertDetails.length,
              genreBeatAlertCount: genreBeatAlertDetails.length,
            });
            break;
          }
        }

        const finalStatus: "succeeded" = "succeeded";
        await this.updateJobSafe(jobId, {
          heartbeatAt: new Date(),
          currentStage: "finalizing",
          currentItemKey: null,
          currentItemLabel: "正在收尾章节流水线任务",
          progress: buildPipelineStageProgress({
            completedCount: completed,
            totalCount,
            stage: "finalizing",
          }),
        });
        await this.updateJobSafe(jobId, {
          status: finalStatus,
          error: null,
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          cancelRequestedAt: null,
          finishedAt: new Date(),
          payload: this.stringifyPipelinePayload({
            ...runtimePayload,
            qualityAlertDetails,
            replanAlertDetails,
            genreBeatAlertDetails,
            recoverableRepairDetails,
            // 终态清零：避免成功后 payload 残留自动重试计数
            jobTransportAutoRetryCount: 0,
          }),
        });
        logPipelineInfo("任务执行结束", {
          jobId,
          status: finalStatus,
          qualityAlertCount: qualityAlertDetails.length,
          genreBeatAlertCount: genreBeatAlertDetails.length,
        });
        void novelEventBus.emit({
          type: "pipeline:completed",
          payload: { novelId, jobId, status: finalStatus },
        }).catch(() => {});
      });
    } catch (error) {
      // 取消文案 / AbortError 统一落 cancelled，禁止 auto-requeue（见 isPipelineCancellationError）。
      if (isPipelineCancellationError(error)) {
        await this.updateJobSafe(jobId, {
          status: "cancelled",
          error: null,
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          cancelRequestedAt: null,
          finishedAt: new Date(),
          payload: this.stringifyPipelinePayload({
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
      }

      // 章节内 empty/transport 重试耗尽后仍瞬时失败：同 job 有限次 requeue（skipCompleted 保已写章）。
      // 取消/AbortError/业务错误不 requeue。预算见 PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX。
      const usedJobAutoRetry = Math.max(0, runtimePayload.jobTransportAutoRetryCount ?? 0);
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
        await this.updateJobSafe(jobId, {
          status: "queued",
          error: retryMessage,
          finishedAt: null,
          heartbeatAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          cancelRequestedAt: null,
          currentStage: "queued",
          currentItemKey: null,
          currentItemLabel: null,
          pendingManualRecovery: false,
          retryCount: totalRetryCount,
          payload: this.stringifyPipelinePayload(requeuePayload),
        });
        logPipelineWarn("任务瞬时失败，排队自动重试", {
          jobId,
          novelId,
          nextCount,
          maxCount: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
          delayMs: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS,
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
        // 必须 defer：当前仍在 schedulePipelineExecution 的 activeJobIds 保护期内，
        // 同步再调 schedule 会被 activeJobIds.has 直接跳过，job 卡在 queued。
        const delayMs = PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS;
        setTimeout(() => {
          this.schedulePipelineExecution(jobId, novelId, resumeOptions);
        }, delayMs).unref?.();
        return;
      }

      await this.updateJobSafe(jobId, {
        status: "failed",
        error: message,
        finishedAt: new Date(),
        payload: this.stringifyPipelinePayload({
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
  }
}
