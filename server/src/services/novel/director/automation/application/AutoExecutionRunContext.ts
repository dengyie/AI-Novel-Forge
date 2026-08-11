import { getDirectorExecutionContext } from "../../runtime/DirectorExecutionContext";
import type { NovelDirectorAutoExecutionRuntimeDeps } from "../novelDirectorAutoExecutionRuntimePorts";
import { AutoExecutionOwnershipFence } from "../domain/AutoExecutionOwnershipFence";
import { AutoExecutionBatchRollCoordinator } from "./AutoExecutionBatchRollCoordinator";

export interface AutoExecutionRunContext {
  ownershipFence: AutoExecutionOwnershipFence;
  runDeps: NovelDirectorAutoExecutionRuntimeDeps;
  batchRollCoordinator: AutoExecutionBatchRollCoordinator;
}

/**
 * Establish the run-local application boundary shared by every auto-execution
 * projection. The worker lease identity is captured once here, and all workflow
 * writes are routed through the same ownership fence for the lifetime of the run.
 */
export function createAutoExecutionRunContext(
  deps: NovelDirectorAutoExecutionRuntimeDeps,
  input: {
    taskId: string;
    signal?: AbortSignal;
    existingPipelineJobId?: string | null;
  },
): AutoExecutionRunContext {
  const ownershipFence = new AutoExecutionOwnershipFence(
    deps,
    input.taskId,
    input.signal,
    input.existingPipelineJobId,
    getDirectorExecutionContext()?.commandExecution,
  );
  const runDeps: NovelDirectorAutoExecutionRuntimeDeps = {
    ...deps,
    ownershipFence,
    workflowService: ownershipFence.bindWorkflowService(deps.workflowService),
  };
  return {
    ownershipFence,
    runDeps,
    batchRollCoordinator: new AutoExecutionBatchRollCoordinator(runDeps),
  };
}
