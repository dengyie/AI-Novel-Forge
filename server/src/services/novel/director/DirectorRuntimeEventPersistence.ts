import { prisma } from "../../../db/prisma";
import { buildRuntimeEventId, stableJson } from "./DirectorRuntimeExecutionHelpers";

export interface RuntimeEventInput {
  runtimeId: string;
  commandId?: string | null;
  executionId?: string | null;
  workflowTaskId?: string | null;
  novelId?: string | null;
  type: string;
  summary: string;
  severity?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createRuntimeEvent(input: RuntimeEventInput): Promise<void> {
  await prisma.directorRuntimeEvent.create({
    data: {
      id: buildRuntimeEventId(input.runtimeId, input.type),
      runtimeId: input.runtimeId,
      commandId: input.commandId,
      executionId: input.executionId,
      workflowTaskId: input.workflowTaskId,
      novelId: input.novelId,
      type: input.type,
      summary: input.summary,
      severity: input.severity ?? "low",
      metadataJson: input.metadata ? stableJson(input.metadata) : undefined,
      occurredAt: new Date(),
    },
  });
}

export async function finishRuntimeExecutionWithError(executionId: string, input: {
  status: "cancelled" | "failed";
  runtimeStatus: string;
  errorClass: string;
  message: string;
  eventType: string;
}): Promise<void> {
  const now = new Date();
  const execution = await prisma.directorRuntimeExecution.findUnique({
    where: { id: executionId },
  });
  if (!execution) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.directorRuntimeExecution.update({
      where: { id: executionId },
      data: {
        status: input.status,
        activeLockKey: null,
        finishedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: null,
        errorClass: input.errorClass,
        errorMessage: input.message,
      },
    });
    if (execution.commandId) {
      await tx.directorRuntimeCommand.update({
        where: { id: execution.commandId },
        data: {
          status: input.status,
          finishedAt: now,
          leaseExpiresAt: null,
          errorMessage: input.message,
        },
      });
    }
    await tx.directorRuntimeInstance.update({
      where: { id: execution.runtimeId },
      data: {
        status: input.runtimeStatus,
        lastHeartbeatAt: now,
        lastErrorClass: input.errorClass,
        lastErrorMessage: input.message,
        workerMessage: input.message,
      },
    });
    await tx.directorRuntimeEvent.create({
      data: {
        id: buildRuntimeEventId(execution.runtimeId, input.eventType),
        runtimeId: execution.runtimeId,
        commandId: execution.commandId,
        executionId,
        workflowTaskId: execution.workflowTaskId,
        novelId: execution.novelId,
        type: input.eventType,
        summary: input.message,
        severity: input.status === "cancelled" ? "low" : "medium",
        occurredAt: now,
      },
    });
  });
}
