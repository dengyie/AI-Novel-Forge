import type { Prisma } from "@prisma/client";
import {
  getWorkflowTaskCommandExecution,
  WorkflowTaskOwnershipLostError,
  type WorkflowTaskCommandExecution,
  type WorkflowTaskOwnershipSnapshot,
} from "./WorkflowTaskOwnership";

const ACTIVE_COMMAND_STATUSES = ["leased", "running"] as const;

export interface WorkflowTaskCommandLeaseRow {
  id: string;
  taskId: string;
  status: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  attempt: number;
}

export function isWorkflowTaskCommandExecutionActive(
  row: WorkflowTaskCommandLeaseRow | null,
  taskId: string,
  execution: WorkflowTaskCommandExecution,
  now = new Date(),
): boolean {
  return Boolean(
    row
    && row.id === execution.commandId
    && row.taskId === taskId
    && ACTIVE_COMMAND_STATUSES.includes(row.status as (typeof ACTIVE_COMMAND_STATUSES)[number])
    && row.leaseOwner === execution.leaseOwner
    && row.attempt === execution.leaseAttempt
    && row.leaseExpiresAt
    && row.leaseExpiresAt.getTime() > now.getTime()
  );
}

export async function fenceWorkflowTaskCommandExecution(
  tx: Prisma.TransactionClient,
  ownership: WorkflowTaskOwnershipSnapshot,
  now = new Date(),
): Promise<void> {
  const execution = getWorkflowTaskCommandExecution(ownership);
  if (!execution) {
    return;
  }
  const fenced = await tx.directorRunCommand.updateMany({
    where: {
      id: execution.commandId,
      taskId: ownership.taskId,
      status: { in: [...ACTIVE_COMMAND_STATUSES] },
      leaseOwner: execution.leaseOwner,
      leaseExpiresAt: { gt: now },
      attempt: execution.leaseAttempt,
    },
    data: {
      leaseExpiresAt: new Date(now.getTime() + Math.max(1, execution.leaseMs)),
    },
  });
  if (fenced.count !== 1) {
    throw new WorkflowTaskOwnershipLostError(ownership.taskId);
  }
}
