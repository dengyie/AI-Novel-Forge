import { prisma } from "../../../../db/prisma";
import { logPipelineWarn } from "../../novelCoreShared";
import {
  buildUnhandledPipelineFailureTerminalCasWhere,
  resolveUnhandledPipelineFailureTerminalUpdate,
} from "../../pipelineJobTerminalGuard";

export interface PipelineJobWritePatch {
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
}

export class PipelineJobWriteService {
  async updateSafe(jobId: string, data: PipelineJobWritePatch): Promise<void> {
    // 心跳、进度与终态统一重试。调用方仍通过更窄的 CAS repository 保护并发所有权；
    // 这里用于已有的单行状态投影和可恢复兜底，不负责改变 CAS 规则。
    const maxAttempts = 3;
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
   * 调度层兜底：仅当任务仍为 running 时补写 failed/cancelled，避免覆盖并发 requeue、
   * cancel 或成功终态。该服务拥有调度异常后的最终状态收束。
   */
  async ensureTerminalAfterUnhandledError(jobId: string, error: unknown): Promise<void> {
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
}
