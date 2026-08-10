import type { NovelDirectorAutoExecutionRuntimeDeps } from "../novelDirectorAutoExecutionRuntimePorts";
import type { NovelDirectorAutoExecutionWorkflowPort } from "../novelDirectorAutoExecutionRuntimePorts";
import {
  isWorkflowTaskOwnershipLost,
  type WorkflowTaskOwnershipSnapshot,
} from "../../../workflow/ownership/WorkflowTaskOwnership";

export class AutoExecutionOwnershipLostError extends Error {
  readonly code = "AUTO_EXECUTION_OWNERSHIP_LOST";

  constructor(readonly taskId: string, readonly pipelineJobId?: string | null) {
    super(`Auto-execution ownership was lost for task ${taskId}.`);
    this.name = "AutoExecutionOwnershipLostError";
  }
}

export function isAutoExecutionOwnershipLost(error: unknown): boolean {
  return error instanceof AutoExecutionOwnershipLostError;
}

export class AutoExecutionRunFailureError extends Error {
  readonly code = "AUTO_EXECUTION_RUN_FAILED";

  constructor(
    override readonly cause: unknown,
    readonly projectionError?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AutoExecutionRunFailureError";
  }
}

export function isAutoExecutionRunFailure(error: unknown): error is AutoExecutionRunFailureError {
  return error instanceof AutoExecutionRunFailureError
    || (error as { code?: unknown } | null)?.code === "AUTO_EXECUTION_RUN_FAILED";
}

/**
 * A run-local write fence. Every state projection or terminal write must pass
 * through this check so a cancelled task or aborted command cannot publish the
 * previous run's state after a retry has taken over.
 */
export class AutoExecutionOwnershipFence {
  private pipelineJobId: string | null;
  private lost = false;
  private ownership: WorkflowTaskOwnershipSnapshot | null = null;

  constructor(
    private readonly deps: Pick<NovelDirectorAutoExecutionRuntimeDeps, "workflowService" | "novelService">,
    private readonly taskId: string,
    private readonly signal?: AbortSignal,
    pipelineJobId?: string | null,
  ) {
    this.pipelineJobId = pipelineJobId?.trim() || null;
  }

  setPipelineJobId(pipelineJobId?: string | null): void {
    this.pipelineJobId = pipelineJobId?.trim() || null;
  }

  async assertActive(): Promise<WorkflowTaskOwnershipSnapshot> {
    if (this.lost) {
      throw new AutoExecutionOwnershipLostError(this.taskId, this.pipelineJobId);
    }
    if (this.signal?.aborted) {
      return this.failOwnership();
    }

    const task = await this.deps.workflowService.getTaskByIdWithoutHealing(this.taskId);
    if (!task || task.status === "cancelled" || Boolean(task.cancelRequestedAt)) {
      return this.failOwnership();
    }

    const current = {
      taskId: this.taskId,
      attemptCount: task.attemptCount,
      ownershipVersion: task.ownershipVersion,
    };
    if (this.ownership && (
      current.attemptCount !== this.ownership.attemptCount
      || current.ownershipVersion !== this.ownership.ownershipVersion
    )) {
      return this.failOwnership();
    }
    this.ownership = current;
    return current;
  }

  async runOwnedWrite<T>(
    writer: (ownership: WorkflowTaskOwnershipSnapshot) => Promise<T>,
  ): Promise<T> {
    const ownership = await this.assertActive();
    try {
      const result = await writer(ownership);
      this.ownership = this.readOwnershipFromWriteResult(result);
      return result;
    } catch (error) {
      if (isWorkflowTaskOwnershipLost(error)) {
        this.lost = true;
        throw new AutoExecutionOwnershipLostError(this.taskId, this.pipelineJobId);
      }
      throw error;
    }
  }

  async runOwnedOperation<T extends { ownership?: WorkflowTaskOwnershipSnapshot | null }>(
    writer: (ownership: WorkflowTaskOwnershipSnapshot) => Promise<T>,
  ): Promise<T> {
    const ownership = await this.assertActive();
    try {
      const result = await writer(ownership);
      if (result?.ownership) {
        this.ownership = this.validateOwnershipSnapshot(result.ownership);
      }
      return result;
    } catch (error) {
      if (isWorkflowTaskOwnershipLost(error)) {
        this.lost = true;
        throw new AutoExecutionOwnershipLostError(this.taskId, this.pipelineJobId);
      }
      throw error;
    }
  }

  bindWorkflowService(
    workflowService: NovelDirectorAutoExecutionWorkflowPort,
  ): NovelDirectorAutoExecutionWorkflowPort {
    return {
      getTaskByIdWithoutHealing: (taskId) => workflowService.getTaskByIdWithoutHealing(taskId),
      bootstrapTask: (input) => this.runOwnedWrite(
        (ownership) => workflowService.bootstrapTask(input, ownership),
      ),
      markTaskRunning: (taskId, input) => this.runOwnedWrite(
        (ownership) => workflowService.markTaskRunning(taskId, input, ownership),
      ),
      recordCheckpoint: (taskId, input) => this.runOwnedWrite(
        (ownership) => workflowService.recordCheckpoint(taskId, input, ownership),
      ),
      markTaskFailed: (taskId, message, patch) => this.runOwnedWrite(
        (ownership) => workflowService.markTaskFailed(taskId, message, patch, ownership),
      ),
    };
  }

  private readOwnershipFromWriteResult(result: unknown): WorkflowTaskOwnershipSnapshot {
    const row = result as { id?: unknown; attemptCount?: unknown; ownershipVersion?: unknown } | null;
    if (
      row?.id !== this.taskId
      || !Number.isInteger(row.attemptCount)
      || !Number.isInteger(row.ownershipVersion)
    ) {
      throw new Error("Owned workflow write did not return a valid ownership snapshot.");
    }
    return this.validateOwnershipSnapshot({
      taskId: this.taskId,
      attemptCount: row.attemptCount as number,
      ownershipVersion: row.ownershipVersion as number,
    });
  }

  private validateOwnershipSnapshot(
    ownership: WorkflowTaskOwnershipSnapshot,
  ): WorkflowTaskOwnershipSnapshot {
    if (
      ownership.taskId !== this.taskId
      || !Number.isInteger(ownership.attemptCount)
      || !Number.isInteger(ownership.ownershipVersion)
    ) {
      throw new Error("Owned operation did not return a valid ownership snapshot.");
    }
    return ownership;
  }

  private async failOwnership(): Promise<never> {
    this.lost = true;
    const pipelineJobId = this.pipelineJobId;
    if (pipelineJobId) {
      await this.deps.novelService.cancelPipelineJob(pipelineJobId);
    }
    throw new AutoExecutionOwnershipLostError(this.taskId, pipelineJobId);
  }
}
