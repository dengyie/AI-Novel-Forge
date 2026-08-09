import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import { isFullBookAutopilotRunMode } from "@ai-novel/shared/types/novelDirector";
import {
  buildDirectorAutoExecutionPipelineOptions,
  resolveDirectorAutoExecutionRepairMode,
  type DirectorAutoExecutionRange,
} from "../novelDirectorAutoExecution";
import { resolveSingleChapterExecutionRange } from "../novelDirectorAutoExecutionRuntimeUtils";
import type { NovelDirectorAutoExecutionRuntimeDeps } from "../novelDirectorAutoExecutionRuntimePorts";
import type { AutoExecutionOwnershipFence } from "../domain/AutoExecutionOwnershipFence";

export async function startAutoExecutionPipelineJob(input: {
  deps: NovelDirectorAutoExecutionRuntimeDeps;
  ownershipFence: AutoExecutionOwnershipFence;
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  range: DirectorAutoExecutionRange;
  autoExecution: DirectorAutoExecutionState;
}): Promise<{ id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" }> {
  await input.ownershipFence.assertActive();
  const modelOverride = input.autoExecution.transientModelOverride;
  const job = await input.deps.novelService.startPipelineJob(
    input.novelId,
    buildDirectorAutoExecutionPipelineOptions({
      provider: modelOverride?.provider ?? input.request.provider,
      model: modelOverride?.model ?? input.request.model,
      temperature: input.request.temperature,
      workflowTaskId: input.taskId,
      taskStyleProfileId: input.request.styleProfileId,
      controlAdvanceMode: isFullBookAutopilotRunMode(input.request.runMode)
        ? "full_book_autopilot"
        : "auto_to_execution",
      ...resolveSingleChapterExecutionRange(input.range, input.autoExecution),
      autoReview: input.autoExecution.autoReview,
      autoRepair: input.autoExecution.autoRepair,
      artifactSyncMode: input.autoExecution.artifactSyncMode,
      repairMode: resolveDirectorAutoExecutionRepairMode(input.autoExecution),
      settingQualityMode: input.request.settingQualityMode ?? "off",
    }),
  );
  input.ownershipFence.setPipelineJobId(job.id);
  return job;
}
