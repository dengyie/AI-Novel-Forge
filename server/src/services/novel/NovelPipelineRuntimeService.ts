import type { NovelCorePipelineService } from "./novelCorePipelineService";

const SERVER_RESTART_RECOVERY_MESSAGE = "章节流水线任务因服务重启中断，正在尝试恢复。";
const STALE_PIPELINE_RECOVERY_MESSAGE = "章节流水线任务心跳超时，正在尝试恢复。";
const DEFAULT_WATCHDOG_INTERVAL_MS = 60000;
const DEFAULT_STALE_THRESHOLD_MS = 3 * 60 * 1000;
/**
 * 本进程活跃 job 的宽限上限：心跳写库（updateJobSafe maxAttempts=1）失败后，
 * watchdog 在宽限内跳过 resume 并补心跳；超过该时长仍失联才允许 stale 拾起，
 * 防止 lease 路径（TTL 300s > stale 180s）把健康 job 永久压在本进程。
 */
const ACTIVE_JOB_STALE_GRACE_MS = 10 * 60 * 1000;

interface PipelineRecoveryPort {
  listPendingCancellationPipelineJobs(): Promise<Array<{ id: string; status: string }>>;
  listRecoverablePipelineJobs(): Promise<Array<{ id: string; status: string }>>;
  listStaleRecoverablePipelineJobs(cutoff: Date, now: Date): Promise<Array<{ id: string; status: string }>>;
  markPipelineJobCancelled(jobId: string): Promise<void>;
  markPipelineJobFailed(jobId: string, message: string): Promise<void>;
  markPipelineJobPendingManualRecovery(jobId: string, message: string): Promise<void>;
}

interface PipelineResumePort {
  resumePipelineJob(jobId: string): Promise<void>;
}

/** 本进程执行中 job 查询口：避免 watchdog 把正在本进程跑的健康 job 误判 stale。 */
interface PipelineActiveJobPort {
  isPipelineJobActiveLocally(jobId: string): boolean;
}

/** 本进程活跃 job 补心跳口：心跳写库失败后的补救（自带重试）。 */
interface PipelineHeartbeatPort {
  touchPipelineJobHeartbeat(jobId: string, maxAttempts?: number): Promise<boolean>;
}

function createPipelineService(): PipelineRecoveryPort & PipelineResumePort {
  const { NovelCorePipelineService } = require("./novelCorePipelineService") as typeof import("./novelCorePipelineService");
  return new NovelCorePipelineService();
}

function createLocalActiveJobPort(): PipelineActiveJobPort & PipelineHeartbeatPort {
  const { NovelCorePipelineService } = require("./novelCorePipelineService") as typeof import("./novelCorePipelineService");
  const { PIPELINE_LEASE_TTL_MS } = require("./pipelineExecutionHelpers") as typeof import("./pipelineExecutionHelpers");
  const { prisma } = require("../../db/prisma") as typeof import("../../db/prisma");
  // activeJobIds 是 pipeline service 的 private static（本组不可改该文件）；
  // 这里只做只读访问。若后续该文件归属本组，应替换为正式的静态查询方法。
  const activeJobIds = (NovelCorePipelineService as unknown as {
    activeJobIds?: Set<string>;
  }).activeJobIds;
  return {
    isPipelineJobActiveLocally(jobId: string): boolean {
      return activeJobIds?.has(jobId) === true;
    },
    async touchPipelineJobHeartbeat(jobId: string, maxAttempts = 3): Promise<boolean> {
      // 自带重试的补偿心跳：仅当 job 仍在 queued/running 时续 heartbeat/lease，
      // 用 updateMany CAS 避免覆盖并发终态/取消。失败不抛——下次 watchdog tick 再试。
      for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
        try {
          const result = await prisma.generationJob.updateMany({
            where: {
              id: jobId,
              status: { in: ["queued", "running"] },
              finishedAt: null,
              cancelRequestedAt: null,
            },
            data: {
              heartbeatAt: new Date(),
              leaseExpiresAt: new Date(Date.now() + PIPELINE_LEASE_TTL_MS),
            },
          });
          return result.count > 0;
        } catch (error) {
          if (attempt >= Math.max(1, maxAttempts)) {
            console.warn("[pipeline-watchdog] 活跃任务补偿心跳写库失败", {
              jobId,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        }
      }
      return false;
    },
  };
}

export class NovelPipelineRuntimeService {
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** jobId → 首次被 watchdog 判为 stale 的时间（本进程活跃 job 宽限计时用）。 */
  private readonly staleFirstSeenAtMs = new Map<string, number>();

  constructor(
    private readonly pipelineService: PipelineRecoveryPort & PipelineResumePort = createPipelineService(),
    private readonly localJobPort: PipelineActiveJobPort & PipelineHeartbeatPort = createLocalActiveJobPort(),
  ) {}

  async resumePendingPipelineJobs(): Promise<void> {
    const pendingCancellationRows = await this.pipelineService.listPendingCancellationPipelineJobs();
    await this.finalizeCancelledJobs(pendingCancellationRows);
    const rows = await this.pipelineService.listRecoverablePipelineJobs();
    await this.recoverJobs(rows, SERVER_RESTART_RECOVERY_MESSAGE);
  }

  async markPendingPipelineJobsForManualRecovery(): Promise<void> {
    const pendingCancellationRows = await this.pipelineService.listPendingCancellationPipelineJobs();
    await this.finalizeCancelledJobs(pendingCancellationRows);
    const rows = await this.pipelineService.listRecoverablePipelineJobs();
    for (const row of rows) {
      await this.pipelineService.markPipelineJobPendingManualRecovery(row.id, "服务重启后任务已暂停，等待手动恢复。");
    }
  }

  async recoverStalePipelineJobs(now = new Date(), staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS): Promise<void> {
    const cutoff = new Date(now.getTime() - Math.max(10000, staleThresholdMs));
    const rows = await this.pipelineService.listStaleRecoverablePipelineJobs(cutoff, now);
    const recoverable: Array<{ id: string; status: string }> = [];
    for (const row of rows) {
      // 本进程正在执行的 job 只是心跳写库失败（updateJobSafe maxAttempts=1），
      // 不是真死：跳过 resume 并补一次带重试的心跳。宽限（默认 10 分钟）内连续
      // 写不进去才放行 stale 拾起，防止 lease 路径把健康 job 永久压住。
      if (this.localJobPort.isPipelineJobActiveLocally(row.id)) {
        const firstSeen = this.staleFirstSeenAtMs.get(row.id) ?? now.getTime();
        this.staleFirstSeenAtMs.set(row.id, firstSeen);
        if (now.getTime() - firstSeen < ACTIVE_JOB_STALE_GRACE_MS) {
          await this.localJobPort.touchPipelineJobHeartbeat(row.id);
          continue;
        }
        console.warn("[pipeline-watchdog] 本进程活跃任务心跳持续失联，放行 stale 恢复", {
          jobId: row.id,
          staleForMs: now.getTime() - firstSeen,
        });
      } else {
        this.staleFirstSeenAtMs.delete(row.id);
      }
      recoverable.push(row);
    }
    // 清理已不再 stale 列表里的残留计时（如 job 已终态），防 Map 泄漏。
    if (this.staleFirstSeenAtMs.size > 0) {
      const rowIds = new Set(rows.map((row) => row.id));
      for (const jobId of this.staleFirstSeenAtMs.keys()) {
        if (!rowIds.has(jobId)) {
          this.staleFirstSeenAtMs.delete(jobId);
        }
      }
    }
    await this.recoverJobs(recoverable, STALE_PIPELINE_RECOVERY_MESSAGE);
  }

  startWatchdog(input: {
    intervalMs?: number;
    staleThresholdMs?: number;
  } = {}): void {
    if (this.watchdogTimer) {
      return;
    }
    const intervalMs = Math.max(15000, input.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS);
    const staleThresholdMs = Math.max(intervalMs * 2, input.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS);
    this.watchdogTimer = setInterval(() => {
      void this.recoverStalePipelineJobs(new Date(), staleThresholdMs).catch((error) => {
        console.warn("Failed to recover stale novel pipeline jobs.", error);
      });
    }, intervalMs);
    this.watchdogTimer.unref?.();
  }

  stopWatchdog(): void {
    if (!this.watchdogTimer) {
      return;
    }
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async recoverJobs(
    rows: Array<{ id: string; status: string }>,
    recoveryMessage: string,
  ): Promise<void> {
    // resume 路径会打 jobTransportAutoRetryCount 日志；此处只保证每条可恢复行被调用。
    // auto-requeue 的 queued（count>0）与普通 queued/running 同一拾起通道，不分支。
    for (const row of rows) {
      try {
        await this.pipelineService.resumePipelineJob(row.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "章节流水线任务恢复失败。";
        await this.pipelineService.markPipelineJobFailed(row.id, `${recoveryMessage} 恢复失败：${message}`);
      }
    }
  }

  private async finalizeCancelledJobs(rows: Array<{ id: string; status: string }>): Promise<void> {
    for (const row of rows) {
      try {
        await this.pipelineService.markPipelineJobCancelled(row.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "章节流水线任务取消收尾失败。";
        await this.pipelineService.markPipelineJobFailed(row.id, `${SERVER_RESTART_RECOVERY_MESSAGE} 取消收尾失败：${message}`);
      }
    }
  }
}
