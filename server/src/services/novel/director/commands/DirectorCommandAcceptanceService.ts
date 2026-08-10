import type {
  DirectorRunCommandStatus,
  DirectorRunCommandType,
} from "@ai-novel/shared/types/directorRuntime";
import { prisma } from "../../../../db/prisma";
import { withSqliteRetry } from "../../../../db/sqliteRetry";
import { AppError } from "../../../../middleware/errorHandler";
import { taskDispatcher } from "../../../../workers/TaskDispatcher";
import { buildAcceptedTaskState } from "./DirectorCommandServiceHelpers";

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const ACTIVE_COMMAND_STATUSES: DirectorRunCommandStatus[] = ["queued", "leased", "running"];

export interface AcceptableDirectorCommand {
  id: string;
  taskId: string;
  commandType: string;
  status: string;
}

interface DirectorCommandAcceptanceOptions {
  preserveLastError?: boolean;
}

export interface DirectorTaskAcceptanceExpectation {
  status: "queued" | "running";
  updatedAt: Date;
  cancelRequestedAt?: Date | null;
  attemptCount?: number;
  pendingManualRecovery?: boolean;
  heartbeatAt: Date | null;
  currentItemKey?: string | null;
}

export interface DirectorRetryTaskExpectation {
  status: "failed" | "cancelled";
  updatedAt: Date;
  cancelRequestedAt: Date | null;
  attemptCount: number;
  pendingManualRecovery: false;
}

/**
 * Owns the durable command + task acceptance boundary.
 *
 * New commands become visible to workers only after their task projection commits in the same
 * transaction. The in-process dispatcher remains a best-effort wake-up hint and is emitted last;
 * cross-process workers continue to rely on polling the durable command table.
 */
export class DirectorCommandAcceptanceService {
  async createAndAccept<T extends AcceptableDirectorCommand>(input: {
    taskId: string;
    commandType: DirectorRunCommandType;
    createCommand: (tx: TransactionClient) => Promise<T>;
    preserveLastError?: boolean;
    expectedTaskState?: DirectorTaskAcceptanceExpectation;
  }): Promise<T> {
    const outcome = await withSqliteRetry(
      () => prisma.$transaction(async (tx) => {
        const projected = input.expectedTaskState
          ? await this.projectAcceptedTask(tx, input.taskId, input.commandType, {
            preserveLastError: input.preserveLastError,
          }, input.expectedTaskState)
          : true;
        if (!projected) {
          return { accepted: false as const, command: null };
        }
        const command = await input.createCommand(tx);
        const projectedAfterCreate = input.expectedTaskState
          ? true
          : await this.projectAcceptedTask(tx, input.taskId, input.commandType, {
            preserveLastError: input.preserveLastError,
          });
        if (projectedAfterCreate) {
          return { accepted: true as const, command };
        }
        await this.cancelUnacceptedCommand(tx, command.id);
        return { accepted: false as const, command };
      }),
      { label: "director.command.accept" },
    );
    if (!outcome.accepted) {
      throw new AppError("Task no longer accepts director commands.", 409);
    }
    this.notifyBestEffort(outcome.command);
    return outcome.command;
  }

  async createAndAcceptRetry<T extends AcceptableDirectorCommand>(input: {
    taskId: string;
    createCommand: (tx: TransactionClient) => Promise<T>;
    expectedTaskState: DirectorRetryTaskExpectation;
    seedPayloadJson?: string;
    supersedeStaleLeasesBefore: Date;
  }): Promise<T> {
    const command = await withSqliteRetry(
      () => prisma.$transaction(async (tx) => {
        await tx.directorRunCommand.updateMany({
          where: {
            taskId: input.taskId,
            status: { in: ["leased", "running"] },
            leaseExpiresAt: { lt: input.supersedeStaleLeasesBefore },
          },
          data: {
            status: "stale",
            leaseExpiresAt: null,
            finishedAt: input.supersedeStaleLeasesBefore,
            errorMessage: "显式重试已替代过期的旧执行命令。",
          },
        });
        const activeCommand = await tx.directorRunCommand.findFirst({
          where: {
            taskId: input.taskId,
            status: { in: ACTIVE_COMMAND_STATUSES },
          },
          select: { id: true },
        });
        if (activeCommand) {
          throw new AppError("Task still has an active director command.", 409);
        }
        const created = await input.createCommand(tx);
        const projected = await tx.novelWorkflowTask.updateMany({
          where: {
            id: input.taskId,
            lane: "auto_director",
            status: input.expectedTaskState.status,
            updatedAt: input.expectedTaskState.updatedAt,
            cancelRequestedAt: input.expectedTaskState.cancelRequestedAt,
            attemptCount: input.expectedTaskState.attemptCount,
            pendingManualRecovery: input.expectedTaskState.pendingManualRecovery,
          },
          data: {
            status: "queued",
            pendingManualRecovery: false,
            attemptCount: input.expectedTaskState.attemptCount + 1,
            lastError: null,
            finishedAt: null,
            cancelRequestedAt: null,
            heartbeatAt: new Date(),
            ...(input.seedPayloadJson ? { seedPayloadJson: input.seedPayloadJson } : {}),
            ownershipVersion: { increment: 1 },
          },
        });
        if (projected.count !== 1) {
          throw new AppError("Task is already being retried or no longer in a retryable state.", 409);
        }
        return created;
      }),
      { label: "director.command.accept-retry" },
    );
    this.notifyBestEffort(command);
    return command;
  }

  async acceptExisting(command: AcceptableDirectorCommand, options: DirectorCommandAcceptanceOptions = {}): Promise<void> {
    // A leased/running command was accepted earlier and may already be mutating runtime state.
    // Reprojecting it as queued would move the task backwards; terminal idempotency reuses also
    // must not manufacture a new queued projection.
    if (command.status !== "queued") {
      return;
    }
    const accepted = await withSqliteRetry(
      () => prisma.$transaction(async (tx) => {
        const projected = await this.projectAcceptedTask(
          tx,
          command.taskId,
          command.commandType as DirectorRunCommandType,
          options,
        );
        if (projected) {
          return true;
        }
        await this.cancelUnacceptedCommand(tx, command.id);
        return false;
      }),
      { label: "director.command.reaccept" },
    );
    if (!accepted) {
      throw new AppError("Task no longer accepts director commands.", 409);
    }
    this.notifyBestEffort(command);
  }

  async projectExistingQueuedCommandIfExpected(
    command: AcceptableDirectorCommand,
    expectedTaskState: DirectorTaskAcceptanceExpectation,
    options: DirectorCommandAcceptanceOptions = {},
  ): Promise<boolean> {
    if (command.status !== "queued") {
      return false;
    }
    const projected = await withSqliteRetry(
      () => prisma.$transaction((tx) => this.projectAcceptedTask(
        tx,
        command.taskId,
        command.commandType as DirectorRunCommandType,
        options,
        expectedTaskState,
      )),
      { label: "director.command.recover-orphan-projection" },
    );
    if (projected) {
      this.notifyBestEffort(command);
    }
    return projected;
  }

  private async projectAcceptedTask(
    tx: TransactionClient,
    taskId: string,
    commandType: DirectorRunCommandType,
    options: DirectorCommandAcceptanceOptions,
    expectedTaskState?: DirectorTaskAcceptanceExpectation,
  ): Promise<boolean> {
    const taskState = buildAcceptedTaskState(commandType);
    const result = await tx.novelWorkflowTask.updateMany({
      where: {
        id: taskId,
        lane: "auto_director",
        status: expectedTaskState?.status ?? { in: ["queued", "running", "waiting_approval", "failed"] },
        cancelRequestedAt: null,
        ...(expectedTaskState ? {
          updatedAt: expectedTaskState.updatedAt,
          ...(Object.prototype.hasOwnProperty.call(expectedTaskState, "attemptCount")
            ? { attemptCount: expectedTaskState.attemptCount }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(expectedTaskState, "pendingManualRecovery")
            ? { pendingManualRecovery: expectedTaskState.pendingManualRecovery }
            : {}),
          heartbeatAt: expectedTaskState.heartbeatAt,
          ...(Object.prototype.hasOwnProperty.call(expectedTaskState, "currentItemKey")
            ? { currentItemKey: expectedTaskState.currentItemKey ?? null }
            : {}),
        } : {}),
      },
      data: {
        status: "queued",
        pendingManualRecovery: false,
        ...(options.preserveLastError ? {} : { lastError: null }),
        ...taskState,
        heartbeatAt: new Date(),
        finishedAt: null,
        cancelRequestedAt: null,
        ownershipVersion: { increment: 1 },
      },
    });
    return result.count > 0;
  }

  private async cancelUnacceptedCommand(tx: TransactionClient, commandId: string): Promise<void> {
    await tx.directorRunCommand.updateMany({
      where: {
        id: commandId,
        status: { in: ACTIVE_COMMAND_STATUSES },
      },
      data: {
        status: "cancelled",
        finishedAt: new Date(),
        errorMessage: "任务状态已变化，命令未被接受。",
      },
    });
  }

  private notifyBestEffort(command: Pick<AcceptableDirectorCommand, "id" | "taskId" | "commandType">): void {
    try {
      taskDispatcher.notify({ commandType: command.commandType, taskId: command.taskId });
    } catch (error) {
      console.warn("[director.command] dispatcher wake-up failed; durable polling remains active", {
        commandId: command.id,
        taskId: command.taskId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
