import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import {
  logPipelineInfo,
  logPipelineWarn,
  type PipelinePayload,
  type PipelineRunOptions,
} from "./novelCoreShared";
import { ensureNovelCharacters } from "./novelCoreSupport";
import { buildPipelineLeaseClaimWhere, buildStaleRecoverablePipelineJobWhere, selectPrimaryPipelineJob } from "./pipelineJobDedup";
import {
  isPipelineCancellationError,
  normalizeJobTransportAutoRetryCount,
  PIPELINE_JOB_AUTO_RETRY_RECOVERY_RESUME_OR_STALE,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
} from "./pipelineJobAutoRetry";
import {
  buildUnhandledPipelineFailureTerminalCasWhere,
  resolveUnhandledPipelineFailureTerminalUpdate,
} from "./pipelineJobTerminalGuard";
import {
  buildPipelineCurrentItemLabel,
  buildPipelineStageProgress,
  decoratePipelineJob as decoratePipelineJobRow,
  isPipelineActiveStage,
  parsePipelinePayload as parsePipelineJobPayload,
  stringifyPipelinePayload as stringifyPipelineJobPayload,
  type DecoratedPipelineJob,
  type PipelineActiveStage,
  type PipelineJobLike,
} from "./pipelineJobState";
import { ChapterRuntimeCoordinator } from "./runtime/ChapterRuntimeCoordinator";
import {
  PIPELINE_LEASE_TTL_MS,
  buildSkipCompletedChapterWhere,
  clampPipelineMaxRetries,
  warnGenerationJobLeaseDisabledOnce,
} from "./pipelineExecutionHelpers";
import { executePipelineJob } from "./pipelineExecute";

export { buildPipelineCurrentItemLabel, buildPipelineStageProgress } from "./pipelineJobState";
export {
  isPipelineCancellationError,
  isPipelineJobAutoRetryableError,
  shouldAutoRetryPipelineJob,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
} from "./pipelineJobAutoRetry";
export {
  clampPipelineMaxRetries,
  buildSkipCompletedChapterWhere,
  buildQualityLoopRiskFlagsSnapshot,
  PIPELINE_HEARTBEAT_INTERVAL_MS,
  PIPELINE_LEASE_TTL_MS,
} from "./pipelineExecutionHelpers";

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

  /**
   * 同区间启动锁最长等待时间：runner 里只做 DB reconcile+create，正常远小于该值。
   * 若持锁方挂起（如 DB 卡顿），不能让 HTTP 请求无限自旋悬挂。
   */
  private static readonly START_LOCK_WAIT_TIMEOUT_MS = 30_000;

  private async waitForStartLock(key: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (NovelCorePipelineService.startLocks.has(key)) {
      if (Date.now() >= deadline) {
        throw new AppError("同区间批量任务正在启动中，请稍后重试。", 409);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async withStartLock<T>(key: string, runner: () => Promise<T>): Promise<T> {
    await this.waitForStartLock(key, NovelCorePipelineService.START_LOCK_WAIT_TIMEOUT_MS);
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
        error: true,
      },
    });
    if (!job) {
      throw new Error("章节流水线任务不存在。");
    }
    if (job.status !== "queued" && job.status !== "running") {
      return;
    }
    const payload = this.parsePipelinePayload(job.payload);
    // 保留 payload（含 jobTransportAutoRetryCount）：resume 只清 lease/manual，不重置预算。
    const jobTransportAutoRetryCount = normalizeJobTransportAutoRetryCount(
      payload.jobTransportAutoRetryCount,
    );
    await this.updateJobSafe(job.id, {
      status: "queued",
      pendingManualRecovery: false,
      heartbeatAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      cancelRequestedAt: null,
    });
    logPipelineInfo("恢复流水线任务调度", {
      jobId: job.id,
      novelId: job.novelId,
      previousStatus: job.status,
      jobTransportAutoRetryCount,
      maxCount: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
      recoveryPath: PIPELINE_JOB_AUTO_RETRY_RECOVERY_RESUME_OR_STALE,
      // 与 requeue / 任务中心 notice 同源：count>0 表示瞬时失败自动重试链路中的拾起
      autoRequeuePending: jobTransportAutoRetryCount > 0,
      errorHint: typeof job.error === "string" && job.error.trim() ? job.error.trim() : null,
    });
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
            settingQualityMode: options.settingQualityMode ?? "off",
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
   * 写库用 status=running CAS，避免 read→write 窗口覆盖并发 requeue/cancel。
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
      const casData = {
        status: terminal.status,
        error: terminal.error,
        finishedAt: new Date(),
        heartbeatAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        ...(terminal.status === "cancelled" ? { cancelRequestedAt: null } : {}),
      };
      // 最多 3 次：仅当仍 running 时写入，防止盖掉 queued requeue / 其它终态
      let applied = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const result = await prisma.generationJob.updateMany({
            where: buildUnhandledPipelineFailureTerminalCasWhere(jobId),
            data: casData,
          });
          if (result.count === 0) {
            logPipelineWarn("流水线调度兜底终态 CAS 未命中（已离开 running）", {
              jobId,
              intendedStatus: terminal.status,
              priorStatus: job?.status ?? null,
            });
            return;
          }
          applied = true;
          break;
        } catch (writeError) {
          lastError = writeError;
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
            continue;
          }
        }
      }
      if (!applied) {
        logPipelineWarn("流水线调度兜底终态写库失败", {
          jobId,
          error: lastError instanceof Error ? lastError.message : String(lastError),
          original: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      logPipelineWarn("流水线调度兜底写入终态", {
        jobId,
        status: terminal.status,
        error: terminal.error,
        cas: "status=running",
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
      // （只保留 activeJobIds，不做 DB CAS）——仅 hot-fix 回退；生产禁止常关（P2-5）。
      const leaseEnabled = process.env.GENERATION_JOB_LEASE_ENABLED !== "false";
      if (!leaseEnabled) {
        warnGenerationJobLeaseDisabledOnce();
      }
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
    await executePipelineJob({
      parsePipelinePayload: (payload) => this.parsePipelinePayload(payload),
      stringifyPipelinePayload: (input) => this.stringifyPipelinePayload(input),
      updateJobSafe: (id, data) => this.updateJobSafe(id, data as Parameters<NovelCorePipelineService["updateJobSafe"]>[1]),
      ensurePipelineNotCancelled: (id) => this.ensurePipelineNotCancelled(id),
      schedulePipelineExecution: (id, nId, opts) => this.schedulePipelineExecution(id, nId, opts),
      chapterRuntimeCoordinator: this.chapterRuntimeCoordinator,
      activeChapterAborts: NovelCorePipelineService.activeChapterAborts,
    }, jobId, novelId, options);
  }
}

