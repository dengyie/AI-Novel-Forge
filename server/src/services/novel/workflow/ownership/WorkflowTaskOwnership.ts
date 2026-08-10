export interface WorkflowTaskOwnershipSnapshot {
  taskId: string;
  attemptCount: number;
  ownershipVersion: number;
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
