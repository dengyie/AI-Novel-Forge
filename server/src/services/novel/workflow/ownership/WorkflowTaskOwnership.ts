export interface WorkflowTaskOwnershipSnapshot {
  taskId: string;
  attemptCount: number;
  ownershipVersion: number;
}

export interface WorkflowTaskCommandExecution {
  commandId: string;
  leaseOwner: string;
  leaseAttempt: number;
  leaseMs: number;
}

interface WorkflowTaskOwnershipRuntime {
  execution?: WorkflowTaskCommandExecution;
  onCommitted?: (ownership: WorkflowTaskOwnershipSnapshot) => void;
}

const ownershipRuntime = new WeakMap<object, WorkflowTaskOwnershipRuntime>();

export function bindWorkflowTaskOwnershipRuntime(
  ownership: WorkflowTaskOwnershipSnapshot,
  runtime: WorkflowTaskOwnershipRuntime,
): WorkflowTaskOwnershipSnapshot {
  const claim = { ...ownership };
  ownershipRuntime.set(claim, runtime);
  return claim;
}

export function getWorkflowTaskCommandExecution(
  ownership: WorkflowTaskOwnershipSnapshot,
): WorkflowTaskCommandExecution | null {
  return ownershipRuntime.get(ownership)?.execution ?? null;
}

export function publishWorkflowTaskOwnershipCommitted(
  ownership: WorkflowTaskOwnershipSnapshot | null | undefined,
  committed: WorkflowTaskOwnershipSnapshot | null | undefined,
): void {
  if (!ownership || !committed) {
    return;
  }
  ownershipRuntime.get(ownership)?.onCommitted?.(committed);
}

export class WorkflowTaskOwnershipLostError extends Error {
  readonly code = "WORKFLOW_TASK_OWNERSHIP_LOST";

  constructor(readonly taskId: string) {
    super(`Workflow task ownership was lost for task ${taskId}.`);
    this.name = "WorkflowTaskOwnershipLostError";
  }
}

export function isWorkflowTaskOwnershipLost(error: unknown): boolean {
  return error instanceof WorkflowTaskOwnershipLostError
    || (error as { code?: unknown } | null)?.code === "WORKFLOW_TASK_OWNERSHIP_LOST";
}
