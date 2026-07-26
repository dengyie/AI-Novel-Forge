import type { DirectorAutoExecutionState } from "@ai-novel/shared/types/novelDirector";
import type { DirectorAutoExecutionChapterRef } from "../novelDirectorAutoExecution";
import type {
  NovelDirectorAutoExecutionRuntimeDeps,
  PipelineJobSnapshot,
} from "../novelDirectorAutoExecutionRuntimePorts";

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
