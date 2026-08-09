import type { NovelDirectorAutoExecutionRuntimeDeps } from "../novelDirectorAutoExecutionRuntimePorts";

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

/**
 * A run-local write fence. Every state projection or terminal write must pass
 * through this check so a cancelled task or aborted command cannot publish the
 * previous run's state after a retry has taken over.
 */
export class AutoExecutionOwnershipFence {
  private pipelineJobId: string | null;
  private lost = false;

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

  async assertActive(): Promise<void> {
    if (this.lost) {
      throw new AutoExecutionOwnershipLostError(this.taskId, this.pipelineJobId);
    }
    const task = await this.deps.workflowService.getTaskById(this.taskId).catch(() => null);
    const cancelled = !task
      || task.status === "cancelled"
      || Boolean((task as { cancelRequestedAt?: unknown } | null)?.cancelRequestedAt);
    if (this.signal?.aborted || cancelled) {
      this.lost = true;
      const pipelineJobId = this.pipelineJobId;
      if (pipelineJobId) {
        await this.deps.novelService.cancelPipelineJob(pipelineJobId).catch(() => null);
      }
      throw new AutoExecutionOwnershipLostError(this.taskId, pipelineJobId);
    }
  }
}
