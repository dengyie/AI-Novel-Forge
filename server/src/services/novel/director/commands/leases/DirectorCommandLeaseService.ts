import crypto from "node:crypto";
import type {
  DirectorRunCommandStatus,
  DirectorRunCommandType,
} from "@ai-novel/shared/types/directorRuntime";
import type { NovelWorkflowTaskStatus } from "@prisma/client";
import { prisma } from "../../../../../db/prisma";
import { withSqliteRetry } from "../../../../../db/sqliteRetry";
import { AppError } from "../../../../../middleware/errorHandler";
import { taskDispatcher } from "../../../../../workers/TaskDispatcher";
import {
  isUniqueConstraintError,
  parsePayload,
  resolveNumberEnv,
  stableJson,
} from "../DirectorCommandServiceHelpers";

type DirectorCommandTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export const DIRECTOR_ACTIVE_COMMAND_STATUSES: DirectorRunCommandStatus[] = ["queued", "leased", "running"];
export const DIRECTOR_EXECUTION_COMMAND_TYPES: DirectorRunCommandType[] = [
  "generate_candidates",
  "refine_candidates",
  "patch_candidate",
  "refine_titles",
  "confirm_candidate",
  "continue",
  "resume_from_checkpoint",
  "retry",
  "takeover",
  "approve_gate",
  "policy_update",
  "workspace_analysis",
  "manual_edit_impact",
  "repair_chapter_titles",
];

const DEFAULT_STALE_AUTO_RECOVERY_MAX_ATTEMPTS = 2;
const STALE_COMMAND_AUTO_RECOVERY_MESSAGE = "后台执行中断，系统已自动从最近进度继续。";
const STALE_COMMAND_MANUAL_RECOVERY_MESSAGE = "后台执行中断，任务已暂停。点击恢复后会从最近进度继续。";
const STALE_COMMAND_INTERNAL_MESSAGE = "Director Worker 租约过期，任务等待恢复。";
const CANCELLED_COMMAND_MESSAGE = "自动导演任务已取消。";

function isAutoRecoverableStaleCommand(command: {
  commandType: string;
  attempt: number;
  payloadJson?: string | null;
}): boolean {
  const defaultMaxAttempts = resolveNumberEnv(
    "DIRECTOR_WORKER_STALE_AUTO_RECOVERY_MAX_ATTEMPTS",
    DEFAULT_STALE_AUTO_RECOVERY_MAX_ATTEMPTS,
  );
  const payload = parsePayload(command.payloadJson ?? null);
  const payloadRunMode = payload.confirmRequest?.runMode ?? payload.takeoverRequest?.runMode ?? null;
  const isFullBookAutopilot = payloadRunMode === "full_book_autopilot";
  const maxAttempts = isFullBookAutopilot
    ? resolveNumberEnv(
      "DIRECTOR_WORKER_FULL_BOOK_STALE_AUTO_RECOVERY_MAX_ATTEMPTS",
      Math.max(defaultMaxAttempts, 5),
    )
    : defaultMaxAttempts;
  return command.attempt < maxAttempts
    && (
      isFullBookAutopilot
      || command.commandType === "continue"
      || command.commandType === "resume_from_checkpoint"
    );
}

export interface DirectorCancellationTaskSnapshot {
  id: string;
  novelId: string | null;
  lane: string;
  status: NovelWorkflowTaskStatus;
  cancelRequestedAt: Date | null;
  updatedAt: Date;
  attemptCount: number;
}

export class DirectorCommandLeaseService {
  async cancelTaskAndCommands(row: DirectorCancellationTaskSnapshot) {
    if (row.lane !== "auto_director") {
      throw new AppError("Only auto director workflow tasks can be queued as director commands.", 400);
    }
    const now = new Date();
    let attemptedIdempotencyKey: string | null = null;
    try {
      return await withSqliteRetry(
        () => prisma.$transaction(async (tx) => {
          let cancelledAt = row.cancelRequestedAt ?? now;
          let taskChanged = false;

          if (row.status === "cancelled") {
            if (row.cancelRequestedAt) {
              attemptedIdempotencyKey = `cancel:${row.cancelRequestedAt.getTime()}`;
              const existing = await tx.directorRunCommand.findFirst({
                where: {
                  taskId: row.id,
                  commandType: "cancel",
                  idempotencyKey: attemptedIdempotencyKey,
                },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              });
              if (existing) {
                return { command: existing, taskChanged: false };
              }
            }

            const claimed = await tx.novelWorkflowTask.updateMany({
              where: {
                id: row.id,
                lane: "auto_director",
                status: "cancelled",
                cancelRequestedAt: row.cancelRequestedAt,
                updatedAt: row.updatedAt,
                attemptCount: row.attemptCount,
              },
              data: row.cancelRequestedAt
                ? { updatedAt: row.updatedAt }
                : { cancelRequestedAt: now, ownershipVersion: { increment: 1 } },
            });
            if (claimed.count !== 1) {
              throw new AppError("Task state changed before cancellation was accepted.", 409);
            }
            if (!row.cancelRequestedAt) {
              cancelledAt = now;
              taskChanged = true;
            }
          } else {
            if (!["queued", "running", "waiting_approval"].includes(row.status)) {
              throw new AppError("Task is no longer cancellable.", 409);
            }
            const claimed = await tx.novelWorkflowTask.updateMany({
              where: {
                id: row.id,
                lane: "auto_director",
                status: row.status,
                cancelRequestedAt: row.cancelRequestedAt,
                updatedAt: row.updatedAt,
                attemptCount: row.attemptCount,
              },
              data: {
                status: "cancelled",
                cancelRequestedAt: now,
                finishedAt: now,
                heartbeatAt: now,
                ownershipVersion: { increment: 1 },
              },
            });
            if (claimed.count !== 1) {
              const latest = await tx.novelWorkflowTask.findUnique({
                where: { id: row.id },
                select: {
                  status: true,
                  cancelRequestedAt: true,
                },
              });
              if (latest?.status === "cancelled" && latest.cancelRequestedAt) {
                attemptedIdempotencyKey = `cancel:${latest.cancelRequestedAt.getTime()}`;
                const existing = await tx.directorRunCommand.findFirst({
                  where: {
                    taskId: row.id,
                    commandType: "cancel",
                    idempotencyKey: attemptedIdempotencyKey,
                  },
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                });
                if (existing) {
                  return { command: existing, taskChanged: false };
                }
              }
              throw new AppError("Task state changed before cancellation was accepted.", 409);
            } else {
              taskChanged = true;
            }
          }

          const idempotencyKey = `cancel:${cancelledAt.getTime()}`;
          attemptedIdempotencyKey = idempotencyKey;
          const existing = await tx.directorRunCommand.findFirst({
            where: {
              taskId: row.id,
              commandType: "cancel",
              idempotencyKey,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          });
          if (existing) {
            return { command: existing, taskChanged };
          }

          await tx.directorRunCommand.updateMany({
            where: {
              taskId: row.id,
              commandType: { in: DIRECTOR_EXECUTION_COMMAND_TYPES },
              status: { in: DIRECTOR_ACTIVE_COMMAND_STATUSES },
            },
            data: {
              status: "cancelled",
              leaseOwner: null,
              leaseExpiresAt: null,
              finishedAt: cancelledAt,
              errorMessage: "用户请求取消自动导演任务。",
            },
          });
          await this.closeCancelledTaskRuntimeState(tx, row.id, cancelledAt);
          const command = await tx.directorRunCommand.create({
            data: {
              taskId: row.id,
              novelId: row.novelId,
              commandType: "cancel",
              idempotencyKey,
              status: "succeeded",
              payloadJson: stableJson({}),
              finishedAt: cancelledAt,
            },
          });
          return { command, taskChanged };
        }),
        { label: "director.command.cancel" },
      );
    } catch (error) {
      if (!isUniqueConstraintError(error) || !attemptedIdempotencyKey) {
        throw error;
      }
      const existing = await prisma.directorRunCommand.findFirst({
        where: {
          taskId: row.id,
          commandType: "cancel",
          idempotencyKey: attemptedIdempotencyKey,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!existing) {
        throw error;
      }
      return { command: existing, taskChanged: false };
    }
  }

  async recoverStaleLeases(now = new Date(), options: { taskId?: string } = {}): Promise<number> {
    const staleCommands = await prisma.directorRunCommand.findMany({
      where: {
        ...(options.taskId ? { taskId: options.taskId } : {}),
        status: { in: ["leased", "running"] },
        leaseExpiresAt: { lt: now },
      },
      select: {
        id: true,
        taskId: true,
        commandType: true,
        status: true,
        leaseOwner: true,
        leaseExpiresAt: true,
        attempt: true,
        payloadJson: true,
      },
    });
    if (staleCommands.length === 0) {
      return 0;
    }
    let recoveredCount = 0;
    let shouldWakeWorker = false;
    for (const command of staleCommands) {
      const autoRecoverable = isAutoRecoverableStaleCommand(command);
      const outcome = await withSqliteRetry(
        () => prisma.$transaction(async (tx) => {
          const transitioned = await tx.directorRunCommand.updateMany({
            where: {
              id: command.id,
              status: command.status,
              leaseOwner: command.leaseOwner,
              leaseExpiresAt: command.leaseExpiresAt,
              attempt: command.attempt,
            },
            data: autoRecoverable
              ? {
                status: "queued",
                leaseOwner: null,
                leaseExpiresAt: null,
                runAfter: now,
                startedAt: null,
                finishedAt: null,
                errorMessage: STALE_COMMAND_AUTO_RECOVERY_MESSAGE,
              }
              : {
                status: "stale",
                leaseExpiresAt: null,
                finishedAt: now,
                errorMessage: STALE_COMMAND_INTERNAL_MESSAGE,
              },
          });
          if (transitioned.count !== 1) {
            return { recovered: false, wakeWorker: false };
          }

          const projected = await tx.novelWorkflowTask.updateMany({
            where: {
              id: command.taskId,
              lane: "auto_director",
              status: { in: ["queued", "running", "waiting_approval", "failed"] },
              cancelRequestedAt: null,
            },
            data: autoRecoverable
              ? {
                status: "queued",
                pendingManualRecovery: false,
                lastError: null,
                heartbeatAt: now,
                finishedAt: null,
                ownershipVersion: { increment: 1 },
              }
              : {
                status: "queued",
                pendingManualRecovery: true,
                lastError: STALE_COMMAND_MANUAL_RECOVERY_MESSAGE,
                heartbeatAt: null,
                finishedAt: null,
                ownershipVersion: { increment: 1 },
              },
          });

          if (projected.count !== 1) {
            if (autoRecoverable) {
              await tx.directorRunCommand.updateMany({
                where: {
                  id: command.id,
                  status: "queued",
                  attempt: command.attempt,
                },
                data: {
                  status: "cancelled",
                  finishedAt: now,
                  errorMessage: "任务状态已变化，过期命令未重新入队。",
                },
              });
            }
            return { recovered: true, wakeWorker: false };
          }

          if (!autoRecoverable) {
            await tx.directorStepRun.updateMany({
              where: {
                taskId: command.taskId,
                status: "running",
              },
              data: {
                status: "failed",
                finishedAt: now,
                error: STALE_COMMAND_INTERNAL_MESSAGE,
              },
            });
          }
          return { recovered: true, wakeWorker: autoRecoverable };
        }),
        { label: "director.command.recover-stale-lease" },
      );
      if (outcome.recovered) {
        recoveredCount += 1;
      }
      shouldWakeWorker ||= outcome.wakeWorker;
    }
    if (shouldWakeWorker) {
      taskDispatcher.notify();
    }
    return recoveredCount;
  }

  async leaseNextCommand(input: { workerId: string; leaseMs: number }) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    const candidate = await prisma.directorRunCommand.findFirst({
      where: {
        status: "queued",
        runAfter: { lte: now },
      },
      orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    if (!candidate) {
      return null;
    }
    const claimed = await prisma.directorRunCommand.updateMany({
      where: {
        id: candidate.id,
        status: "queued",
      },
      data: {
        status: "leased",
        leaseOwner: input.workerId,
        leaseExpiresAt,
        attempt: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return null;
    }
    return prisma.directorRunCommand.findUnique({ where: { id: candidate.id } });
  }

  async markCommandRunning(commandId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const now = new Date();
    const updated = await prisma.directorRunCommand.updateMany({
      where: {
        id: commandId,
        leaseOwner: workerId,
        status: { in: ["leased", "running"] },
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: "running",
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });
    return updated.count === 1;
  }

  async renewLease(commandId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const now = new Date();
    const updated = await prisma.directorRunCommand.updateMany({
      where: {
        id: commandId,
        leaseOwner: workerId,
        status: { in: ["leased", "running"] },
        leaseExpiresAt: { gt: now },
      },
      data: {
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });
    return updated.count === 1;
  }

  async markCommandSucceeded(commandId: string, workerId: string): Promise<boolean> {
    const now = new Date();
    const updated = await prisma.directorRunCommand.updateMany({
      where: {
        id: commandId,
        leaseOwner: workerId,
        status: { in: ["leased", "running"] },
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: "succeeded",
        leaseExpiresAt: null,
        finishedAt: now,
        errorMessage: null,
      },
    });
    return updated.count === 1;
  }

  async markCommandCancelled(commandId: string, workerId: string): Promise<boolean> {
    const finishedAt = new Date();
    return prisma.$transaction(async (tx) => {
      const updated = await tx.directorRunCommand.updateMany({
        where: {
          id: commandId,
          leaseOwner: workerId,
          status: { in: ["leased", "running"] },
          leaseExpiresAt: { gt: finishedAt },
        },
        data: {
          status: "cancelled",
          leaseExpiresAt: null,
          finishedAt,
          errorMessage: CANCELLED_COMMAND_MESSAGE,
        },
      });
      if (updated.count !== 1) {
        return false;
      }
      const command = await tx.directorRunCommand.findUnique({
        where: { id: commandId },
        select: { taskId: true },
      });
      if (command) {
        await this.closeCancelledTaskRuntimeState(tx, command.taskId, finishedAt);
      }
      return true;
    });
  }

  async markCommandFailed(commandId: string, workerId: string, error: unknown): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date();
    const outcome = await prisma.$transaction(async (tx) => {
      const updated = await tx.directorRunCommand.updateMany({
        where: {
          id: commandId,
          leaseOwner: workerId,
          status: { in: ["leased", "running"] },
          leaseExpiresAt: { gt: failedAt },
        },
        data: {
          status: "failed",
          leaseExpiresAt: null,
          finishedAt: failedAt,
          errorMessage: message,
        },
      });
      if (updated.count !== 1) {
        return { claimed: false };
      }

      const command = await tx.directorRunCommand.findUnique({
        where: { id: commandId },
        select: { taskId: true },
      });
      if (!command) {
        return { claimed: true };
      }

      const task = await tx.novelWorkflowTask.findUnique({
        where: { id: command.taskId },
      });
      if (!task || task.cancelRequestedAt != null || !["queued", "running", "waiting_approval", "failed"].includes(task.status)) {
        return { claimed: true };
      }

      const projected = await tx.novelWorkflowTask.updateMany({
        where: {
          id: task.id,
          status: task.status,
          cancelRequestedAt: null,
          updatedAt: task.updatedAt,
          attemptCount: task.attemptCount,
        },
        data: {
          status: "queued",
          pendingManualRecovery: true,
          finishedAt: null,
          cancelRequestedAt: null,
          heartbeatAt: null,
          lastError: message.trim(),
          ownershipVersion: { increment: 1 },
        },
      });
      if (projected.count !== 1) {
        return { claimed: true };
      }

      await tx.directorStepRun.updateMany({
        where: {
          taskId: task.id,
          status: "running",
        },
        data: {
          status: "failed",
          finishedAt: failedAt,
          error: message,
        },
      });
      return { claimed: true };
    });
    return outcome.claimed;
  }

  private async closeCancelledTaskRuntimeState(
    tx: DirectorCommandTransaction,
    taskId: string,
    now: Date,
  ): Promise<void> {
    await tx.directorStepRun.updateMany({
      where: {
        taskId,
        status: "running",
      },
      data: {
        status: "failed",
        finishedAt: now,
        error: CANCELLED_COMMAND_MESSAGE,
      },
    });
    await tx.generationJob.updateMany({
      where: {
        status: { in: ["queued", "running"] },
        payload: { contains: taskId },
      },
      data: {
        status: "cancelled",
        cancelRequestedAt: now,
        finishedAt: now,
        error: CANCELLED_COMMAND_MESSAGE,
      },
    });
    const run = await tx.directorRun.findUnique({
      where: { taskId },
      select: { id: true, novelId: true },
    });
    if (!run) {
      return;
    }
    await tx.directorEvent.create({
      data: {
        id: `${taskId}:run_cancelled:${crypto.randomUUID()}`,
        runId: run.id,
        taskId,
        novelId: run.novelId,
        type: "run_cancelled",
        summary: "自动导演已停止，后台运行状态已收束。",
        severity: "low",
        occurredAt: now,
      },
    });
  }
}
