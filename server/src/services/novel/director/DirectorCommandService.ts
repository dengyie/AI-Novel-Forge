import crypto from "node:crypto";
import type {
  DirectorCommandAcceptedResponse,
  DirectorRunCommandStatus,
  DirectorRunCommandType,
} from "@ai-novel/shared/types/directorRuntime";
import type {
  DirectorContinuationMode,
  DirectorLLMOptions,
  DirectorTakeoverRequest,
} from "@ai-novel/shared/types/novelDirector";
import { prisma } from "../../../db/prisma";
import { withSqliteRetry } from "../../../db/sqliteRetry";
import { AppError } from "../../../middleware/errorHandler";
import { NovelWorkflowService } from "../workflow/NovelWorkflowService";

const ACTIVE_COMMAND_STATUSES: DirectorRunCommandStatus[] = ["queued", "leased", "running"];
const EXECUTION_COMMAND_TYPES: DirectorRunCommandType[] = [
  "continue",
  "resume_from_checkpoint",
  "retry",
  "takeover",
  "repair_chapter_titles",
];
const STALE_COMMAND_RECOVERY_MESSAGE = "Director Worker 租约过期，任务等待手动恢复。";

export interface DirectorCommandPayload {
  continuationMode?: DirectorContinuationMode;
  batchAlreadyStartedCount?: number;
  forceResume?: boolean;
  takeoverRequest?: DirectorTakeoverRequest;
  volumeId?: string | null;
}

export type DirectorRunCommandRow = Awaited<ReturnType<DirectorCommandService["getCommandById"]>>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
}

function hashPayload(value: unknown): string {
  return crypto.createHash("sha1").update(stableJson(value)).digest("hex").slice(0, 12);
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

function toAcceptedResponse(command: {
  id: string;
  taskId: string;
  novelId: string | null;
  commandType: string;
  status: string;
  leaseExpiresAt: Date | null;
}): DirectorCommandAcceptedResponse {
  return {
    commandId: command.id,
    taskId: command.taskId,
    novelId: command.novelId,
    commandType: command.commandType as DirectorRunCommandType,
    status: command.status as DirectorRunCommandStatus,
    leaseExpiresAt: command.leaseExpiresAt?.toISOString() ?? null,
  };
}

function parsePayload(payloadJson: string | null): DirectorCommandPayload {
  if (!payloadJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" ? parsed as DirectorCommandPayload : {};
  } catch {
    return {};
  }
}

export class DirectorCommandService {
  constructor(private readonly workflowService = new NovelWorkflowService()) {}

  async enqueueContinueCommand(taskId: string, input: DirectorCommandPayload = {}): Promise<DirectorCommandAcceptedResponse> {
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "continue",
      payload: input,
    });
  }

  async enqueueRecoveryCommand(taskId: string, input: DirectorCommandPayload = {}): Promise<DirectorCommandAcceptedResponse> {
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "resume_from_checkpoint",
      payload: {
        ...input,
        forceResume: true,
      },
    });
  }

  async enqueueRetryCommand(input: {
    taskId: string;
    llmOverride?: Pick<DirectorLLMOptions, "provider" | "model" | "temperature">;
    batchAlreadyStartedCount?: number;
  }): Promise<DirectorCommandAcceptedResponse> {
    const row = await this.workflowService.getTaskById(input.taskId);
    if (!row) {
      throw new AppError("Task not found.", 404);
    }
    if (row.lane !== "auto_director") {
      throw new AppError("Only auto director workflow tasks can be queued as director commands.", 400);
    }
    if (input.llmOverride) {
      await this.workflowService.applyAutoDirectorLlmOverride(input.taskId, input.llmOverride);
    }
    await this.workflowService.retryTask(input.taskId);
    return this.enqueueExecutionCommand({
      taskId: input.taskId,
      commandType: "retry",
      payload: {
        forceResume: true,
        batchAlreadyStartedCount: input.batchAlreadyStartedCount,
      },
    });
  }

  async enqueueCancelCommand(taskId: string): Promise<DirectorCommandAcceptedResponse> {
    const row = await this.workflowService.getTaskById(taskId);
    if (!row) {
      throw new AppError("Task not found.", 404);
    }
    if (row.lane !== "auto_director") {
      throw new AppError("Only auto director workflow tasks can be queued as director commands.", 400);
    }
    await this.workflowService.cancelTask(taskId);
    await prisma.directorRunCommand.updateMany({
      where: {
        taskId,
        commandType: { in: EXECUTION_COMMAND_TYPES },
        status: { in: ACTIVE_COMMAND_STATUSES },
      },
      data: {
        status: "cancelled",
        finishedAt: new Date(),
        errorMessage: "用户请求取消自动导演任务。",
      },
    });
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "cancel",
      payload: {},
      allowTerminalReuse: false,
    });
  }

  async enqueueTakeoverCommand(input: DirectorTakeoverRequest): Promise<DirectorCommandAcceptedResponse> {
    const reusableCommand = await prisma.directorRunCommand.findFirst({
      where: {
        novelId: input.novelId,
        commandType: "takeover",
        status: { in: ACTIVE_COMMAND_STATUSES },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (reusableCommand) {
      return toAcceptedResponse(reusableCommand);
    }

    const task = await this.workflowService.bootstrapTask({
      novelId: input.novelId,
      lane: "auto_director",
      title: "自动导演接管",
      forceNew: true,
      initialState: {
        stage: "auto_director",
        itemKey: "takeover",
        itemLabel: "自动导演接管任务已提交",
        progress: 0,
      },
      seedPayload: {
        takeover: {
          entryStep: input.entryStep ?? null,
          startPhase: input.startPhase ?? null,
          strategy: input.strategy ?? null,
          autoExecutionPlan: input.autoExecutionPlan ?? null,
        },
      },
    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "takeover",
      payload: {
        takeoverRequest: input,
      },
    });
  }

  async enqueueChapterTitleRepairCommand(taskId: string, input: {
    volumeId?: string | null;
  } = {}): Promise<DirectorCommandAcceptedResponse> {
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "repair_chapter_titles",
      payload: {
        volumeId: input.volumeId?.trim() || null,
      },
      preserveLastError: true,
    });
  }

  async getCommandById(commandId: string) {
    return prisma.directorRunCommand.findUnique({
      where: { id: commandId },
    });
  }

  async recoverStaleLeases(now = new Date()): Promise<number> {
    const staleCommands = await prisma.directorRunCommand.findMany({
      where: {
        status: { in: ["leased", "running"] },
        leaseExpiresAt: { lt: now },
      },
      select: { id: true, taskId: true },
    });
    if (staleCommands.length === 0) {
      return 0;
    }
    const staleIds = staleCommands.map((command) => command.id);
    await prisma.directorRunCommand.updateMany({
      where: { id: { in: staleIds } },
      data: {
        status: "stale",
        finishedAt: now,
        errorMessage: STALE_COMMAND_RECOVERY_MESSAGE,
      },
    });
    const taskIds = Array.from(new Set(staleCommands.map((command) => command.taskId)));
    for (const taskId of taskIds) {
      await prisma.directorStepRun.updateMany({
        where: {
          taskId,
          status: "running",
        },
        data: {
          status: "failed",
          finishedAt: now,
          error: STALE_COMMAND_RECOVERY_MESSAGE,
        },
      }).catch(() => null);
      await this.workflowService.requeueTaskForRecovery(taskId, "Director Worker 已中断，任务已暂停，等待手动恢复。")
        .catch(() => null);
    }
    return staleCommands.length;
  }

  async leaseNextCommand(input: {
    workerId: string;
    leaseMs: number;
  }) {
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
    return this.getCommandById(candidate.id);
  }

  async markCommandRunning(commandId: string, workerId: string, leaseMs: number) {
    const now = new Date();
    await prisma.directorRunCommand.updateMany({
      where: {
        id: commandId,
        leaseOwner: workerId,
        status: { in: ["leased", "running"] },
      },
      data: {
        status: "running",
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });
  }

  async renewLease(commandId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const updated = await prisma.directorRunCommand.updateMany({
      where: {
        id: commandId,
        leaseOwner: workerId,
        status: { in: ["leased", "running"] },
      },
      data: {
        leaseExpiresAt: new Date(Date.now() + leaseMs),
      },
    });
    return updated.count === 1;
  }

  async markCommandSucceeded(commandId: string, workerId: string): Promise<void> {
    await prisma.directorRunCommand.updateMany({
      where: {
        id: commandId,
        leaseOwner: workerId,
        status: { in: ["leased", "running"] },
      },
      data: {
        status: "succeeded",
        leaseExpiresAt: null,
        finishedAt: new Date(),
        errorMessage: null,
      },
    });
  }

  async markCommandFailed(commandId: string, workerId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date();
    const updated = await prisma.directorRunCommand.updateMany({
      where: {
        id: commandId,
        leaseOwner: workerId,
        status: { in: ["leased", "running"] },
      },
      data: {
        status: "failed",
        leaseExpiresAt: null,
        finishedAt: failedAt,
        errorMessage: message,
      },
    });
    if (updated.count !== 1) {
      return;
    }
    const command = await this.getCommandById(commandId);
    if (!command) {
      return;
    }
    await prisma.directorStepRun.updateMany({
      where: {
        taskId: command.taskId,
        status: "running",
      },
      data: {
        status: "failed",
        finishedAt: failedAt,
        error: message,
      },
    }).catch(() => null);
    await this.workflowService.requeueTaskForRecovery(command.taskId, message)
      .catch(() => null);
  }

  parseCommandPayload(command: NonNullable<DirectorRunCommandRow>): DirectorCommandPayload {
    return parsePayload(command.payloadJson);
  }

  async getLatestTakeoverRequestForTask(taskId: string): Promise<DirectorTakeoverRequest | null> {
    const command = await prisma.directorRunCommand.findFirst({
      where: {
        taskId,
        commandType: "takeover",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!command) {
      return null;
    }
    return parsePayload(command.payloadJson).takeoverRequest ?? null;
  }

  private async enqueueExecutionCommand(input: {
    taskId: string;
    commandType: DirectorRunCommandType;
    payload: DirectorCommandPayload;
    allowTerminalReuse?: boolean;
    preserveLastError?: boolean;
  }): Promise<DirectorCommandAcceptedResponse> {
    const row = await this.workflowService.getTaskById(input.taskId);
    if (!row) {
      throw new AppError("Task not found.", 404);
    }
    if (row.lane !== "auto_director") {
      throw new AppError("Only auto director workflow tasks can be queued as director commands.", 400);
    }
    const reusableCommand = await prisma.directorRunCommand.findFirst({
      where: {
        taskId: input.taskId,
        commandType: input.commandType === "cancel" ? "cancel" : { in: EXECUTION_COMMAND_TYPES },
        status: { in: ACTIVE_COMMAND_STATUSES },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (reusableCommand) {
      return toAcceptedResponse(reusableCommand);
    }

    const normalizedPayload = Object.fromEntries(
      Object.entries(input.payload).filter(([, value]) => value !== undefined),
    );
    const idempotencyKey = `${input.commandType}:${row.updatedAt.getTime()}:${hashPayload(normalizedPayload)}`;
    const payloadJson = stableJson(normalizedPayload);
    const createCommand = () => prisma.directorRunCommand.create({
      data: {
        taskId: input.taskId,
        novelId: row.novelId,
        commandType: input.commandType,
        idempotencyKey,
        status: "queued",
        payloadJson,
      },
    });

    try {
      const command = await withSqliteRetry(createCommand, { label: "director.command.create" });
      await this.markCommandAcceptedOnTask(input.taskId, {
        preserveLastError: input.preserveLastError,
      });
      return toAcceptedResponse(command);
    } catch (error) {
      if (!isUniqueConstraintError(error) || input.allowTerminalReuse === false) {
        throw error;
      }
      const existing = await prisma.directorRunCommand.findFirst({
        where: {
          taskId: input.taskId,
          commandType: input.commandType,
          idempotencyKey,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!existing) {
        throw error;
      }
      return toAcceptedResponse(existing);
    }
  }

  private async markCommandAcceptedOnTask(taskId: string, options: {
    preserveLastError?: boolean;
  } = {}): Promise<void> {
    await prisma.novelWorkflowTask.updateMany({
      where: {
        id: taskId,
        OR: [
          { status: { in: ["queued", "running", "waiting_approval", "failed"] } },
          { pendingManualRecovery: true },
        ],
      },
      data: {
        status: "queued",
        pendingManualRecovery: false,
        ...(options.preserveLastError ? {} : { lastError: null }),
        heartbeatAt: new Date(),
        finishedAt: null,
        cancelRequestedAt: null,
      },
    }).catch(() => null);
  }
}
