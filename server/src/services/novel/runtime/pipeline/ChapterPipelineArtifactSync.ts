import type { ContentProvenance } from "@ai-novel/shared/types/canonicalState";
import type { RunPipelineChapterDeps, PipelineRuntimeInput } from "./ChapterPipelineContracts";

export async function syncFinalRetainedChapterArtifacts(
  deps: RunPipelineChapterDeps,
  novelId: string,
  chapterId: string,
  content: string,
  expectedContentRevision: number,
  artifactSyncMode: PipelineRuntimeInput["artifactSyncMode"],
  contentProvenance: ContentProvenance,
): Promise<void> {
  if (!content.trim()) {
    return;
  }
  await deps.syncFinalChapterArtifacts(novelId, chapterId, content, {
    expectedContentRevision,
    artifactSyncMode,
    contentProvenance,
  });
}
