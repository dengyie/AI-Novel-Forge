import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../db/prisma";
import { logPipelineWarn } from "../../novelCoreShared";
import { buildPipelineLeaseClaimWhere } from "../../pipelineJobDedup";
import {
  buildPipelineJobLeaseOwnedCasWhere,
  buildUnhandledPipelineFailureTerminalCasWhere,
  resolveUnhandledPipelineFailureTerminalUpdate,
} from "../../pipelineJobTerminalGuard";
import { PIPELINE_LEASE_TTL_MS } from "../../pipelineExecutionHelpers";

export class PipelineJobWriteService {
  beginExecution(input: {
    jobId: string;
    leaseOwner: string | null;
    startedAt: Date;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const ownerWhere: Prisma.GenerationJobWhereInput = input.leaseOwner
      ? buildPipelineJobLeaseOwnedCasWhere(input.jobId, input.leaseOwner)
      : {
        id: input.jobId,
        status: { in: ["queued", "running"] },
        leaseOwner: null,
      };
    return prisma.generationJob.updateMany({
      where: {
        ...ownerWhere,
        cancelRequestedAt: null,
        finishedAt: null,
      },
      data: {
        status: "running",
        error: null,
        pendingManualRecovery: false,
        startedAt: input.startedAt,
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + PIPELINE_LEASE_TTL_MS),
        currentStage: "generating_chapters",
        finishedAt: null,
      },
    });
  }

  claimForResume(jobId: string, now: Date = new Date()) {
    return prisma.generationJob.updateMany({
      where: {
        ...buildPipelineLeaseClaimWhere({ jobId, now }),
        finishedAt: null,
      },
      data: {
        status: "queued",
        pendingManualRecovery: false,
        heartbeatAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        cancelRequestedAt: null,
      },
    });
  }

  markFailedIfRecoverable(jobId: string, message: string, now: Date = new Date()) {
    return prisma.generationJob.updateMany({
      where: {
        ...buildPipelineLeaseClaimWhere({ jobId, now }),
        finishedAt: null,
      },
      data: {
        status: "failed",
        error: message.trim(),
        heartbeatAt: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        cancelRequestedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
      },
    });
  }

  markCancelledIfPending(jobId: string, now: Date = new Date()) {
    return prisma.generationJob.updateMany({
      where: {
        id: jobId,
        status: "cancelled",
        cancelRequestedAt: { not: null },
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
        finishedAt: null,
      },
      data: {
        heartbeatAt: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        cancelRequestedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
      },
    });
  }

  markPendingManualRecoveryIfRecoverable(jobId: string, message: string, now: Date = new Date()) {
    return prisma.generationJob.updateMany({
      where: {
        ...buildPipelineLeaseClaimWhere({ jobId, now }),
        finishedAt: null,
      },
      data: {
        status: "queued",
        error: message.trim(),
        pendingManualRecovery: true,
        heartbeatAt: null,
        currentStage: "queued",
        currentItemKey: null,
        currentItemLabel: null,
        cancelRequestedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: null,
      },
    });
  }

  settleCancelled(input: {
    jobId: string;
    leaseOwner: string | null;
    payload: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return prisma.generationJob.updateMany({
      where: {
        id: input.jobId,
        finishedAt: null,
        leaseOwner: input.leaseOwner,
        OR: [
          { status: "running" },
          { status: "cancelled", cancelRequestedAt: { not: null } },
        ],
      },
      data: {
        status: "cancelled",
        error: null,
        heartbeatAt: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        cancelRequestedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        payload: input.payload,
      },
    });
  }

  settleFailed(input: {
    jobId: string;
    leaseOwner: string | null;
    error: string;
    payload: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return prisma.generationJob.updateMany({
      where: {
        ...buildPipelineJobLeaseOwnedCasWhere(input.jobId, input.leaseOwner),
        cancelRequestedAt: null,
        finishedAt: null,
      },
      data: {
        status: "failed",
        error: input.error,
        heartbeatAt: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        payload: input.payload,
      },
    });
  }

  /**
   * 调度层兜底：仅当任务仍为 running 且仍归当前 owner 时补写 failed/cancelled，
   * 避免覆盖并发 requeue、cancel、成功终态或新 owner。该服务拥有调度异常后的最终状态收束。
   */
  async ensureTerminalAfterUnhandledError(
    jobId: string,
    leaseOwner: string | null,
    error: unknown,
  ): Promise<void> {
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
            where: buildUnhandledPipelineFailureTerminalCasWhere(jobId, leaseOwner),
            data: casData,
          });
          if (result.count === 0) {
            logPipelineWarn("流水线调度兜底终态 CAS 未命中（已离开 running）", {
              jobId,
              intendedStatus: terminal.status,
              priorStatus: job?.status ?? null,
              leaseOwner,
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
        cas: "status=running+leaseOwner",
        leaseOwner,
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
