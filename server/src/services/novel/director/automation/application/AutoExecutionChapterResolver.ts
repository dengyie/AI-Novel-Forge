import type { DirectorAutoExecutionState, DirectorConfirmRequest } from "@ai-novel/shared/types/novelDirector";
import type { DirectorAutoExecutionChapterRef, DirectorAutoExecutionRange } from "../novelDirectorAutoExecution";
import type {
  NovelDirectorAutoExecutionRuntimeDeps,
  PipelineJobSnapshot,
} from "../novelDirectorAutoExecutionRuntimePorts";
import { resolveSingleChapterExecutionRange } from "../novelDirectorAutoExecutionRuntimeUtils";
import { resolveAutoExecutionRuntimeRangeAndState } from "../novelDirectorAutoExecutionRuntimePreparation";
import { syncAutoExecutionTaskState, type AutoExecutionResumeStage } from "../novelDirectorAutoExecutionCheckpointRuntime";
import type { AutoExecutionOwnershipFence } from "../domain/AutoExecutionOwnershipFence";

export async function resolvePipelineJobForExecution(
  deps: NovelDirectorAutoExecutionRuntimeDeps,
  jobId: string,
): Promise<PipelineJobSnapshot> {
  let job = await deps.novelService.getPipelineJobById(jobId);
  if (!job?.pendingManualRecovery) {
    return job;
  }
  await deps.novelService.resumePipelineJob(job.id);
  job = await deps.novelService.getPipelineJobById(job.id);
  return job;
}

export async function resolveOwnedActiveRangePipeline(input: {
  deps: NovelDirectorAutoExecutionRuntimeDeps;
  ownershipFence: AutoExecutionOwnershipFence;
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  range: DirectorAutoExecutionRange;
  autoExecution: DirectorAutoExecutionState;
  pipelineJobId?: string | null;
  knownPipelineJob?: PipelineJobSnapshot;
  allowLazyChapterPlanning: boolean;
  resumeStage?: AutoExecutionResumeStage;
}): Promise<{
  range: DirectorAutoExecutionRange;
  autoExecution: DirectorAutoExecutionState;
  pipelineJobId: string;
}> {
  let pipelineJobId = input.pipelineJobId?.trim() || "";
  if (pipelineJobId) {
    const existingJob = input.knownPipelineJob
      ?? await resolvePipelineJobForExecution(input.deps, pipelineJobId);
    if (!existingJob || ["failed", "cancelled"].includes(existingJob.status)) {
      pipelineJobId = "";
      input.ownershipFence.setPipelineJobId(null);
    }
  }
  const executionRange = resolveSingleChapterExecutionRange(input.range, input.autoExecution);
  const activeRangeJob = await input.deps.novelService.findActivePipelineJobForRange(
    input.novelId,
    executionRange.startOrder,
    executionRange.endOrder,
    pipelineJobId || null,
  );
  if (!activeRangeJob) {
    return { range: input.range, autoExecution: input.autoExecution, pipelineJobId };
  }
  input.ownershipFence.setPipelineJobId(activeRangeJob.id);
  const resolved = await resolveAutoExecutionRuntimeRangeAndState(input.deps, {
    novelId: input.novelId,
    existingState: input.autoExecution,
    pipelineJobId: activeRangeJob.id,
    pipelineStatus: activeRangeJob.status,
    allowLazyChapterPlanning: input.allowLazyChapterPlanning,
  });
  await syncAutoExecutionTaskState(input.deps, {
    taskId: input.taskId,
    novelId: input.novelId,
    request: input.request,
    range: resolved.range,
    autoExecution: resolved.autoExecution,
    isBackgroundRunning: true,
    resumeStage: input.resumeStage,
    ownershipFence: input.ownershipFence,
  });
  return { ...resolved, pipelineJobId: activeRangeJob.id };
}

export async function resolveQualityIssueChapter(
  deps: NovelDirectorAutoExecutionRuntimeDeps,
  novelId: string,
  job: NonNullable<PipelineJobSnapshot>,
): Promise<DirectorAutoExecutionChapterRef | null> {
  const startOrder = typeof job.startOrder === "number" && Number.isFinite(job.startOrder)
    ? job.startOrder
    : null;
  const endOrder = typeof job.endOrder === "number" && Number.isFinite(job.endOrder)
    ? job.endOrder
    : null;
  if (startOrder == null || (endOrder != null && endOrder !== startOrder)) {
    return null;
  }
  const chapters = await deps.novelContextService.listChapters(novelId);
  return chapters.find((chapter) => chapter.order === startOrder) ?? null;
}

export async function resolveStuckNoGeneratableChapter(
  deps: NovelDirectorAutoExecutionRuntimeDeps,
  novelId: string,
  autoExecution: DirectorAutoExecutionState,
): Promise<DirectorAutoExecutionChapterRef | null> {
  const nextOrder = typeof autoExecution.nextChapterOrder === "number"
    && Number.isFinite(autoExecution.nextChapterOrder)
    ? autoExecution.nextChapterOrder
    : null;
  const nextId = autoExecution.nextChapterId?.trim() || null;
  if (nextOrder == null && !nextId) {
    return null;
  }
  const chapters = await deps.novelContextService.listChapters(novelId);
  if (nextId) {
    const byId = chapters.find((chapter) => chapter.id === nextId);
    if (byId) {
      return byId;
    }
  }
  return nextOrder == null
    ? null
    : chapters.find((chapter) => chapter.order === nextOrder) ?? null;
}
