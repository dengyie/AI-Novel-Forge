import {
  ChapterArtifactDeltaOrchestrator,
  buildContentHash,
  mergeKnowledgeBoundaryState,
  type ChapterArtifactDeltaSyncInput,
  type ChapterArtifactDeltaSyncResult,
} from "./artifacts";

export type { ChapterArtifactDeltaSyncInput, ChapterArtifactDeltaSyncResult } from "./artifacts";
export { buildContentHash, mergeKnowledgeBoundaryState } from "./artifacts";

export class ChapterArtifactDeltaService {
  constructor(private readonly orchestrator = new ChapterArtifactDeltaOrchestrator()) {}

  syncChapterArtifacts(input: ChapterArtifactDeltaSyncInput): Promise<ChapterArtifactDeltaSyncResult> {
    return this.orchestrator.syncChapterArtifacts(input);
  }
}

export const chapterArtifactDeltaService = new ChapterArtifactDeltaService();
