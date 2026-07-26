import type { BaseMessageChunk } from "@langchain/core/messages";
import type { StreamDoneHelpers } from "../../../../llm/streaming";
import type { RepairOptions } from "../../novelCoreShared";
import type { ChapterArtifactSyncService } from "../ChapterArtifactSyncService";
import { ChapterContentCommitService } from "../content/ChapterContentCommitService";
import type { GenerationContextAssembler } from "../GenerationContextAssembler";
import {
  ChapterRepairStreamOrchestrator,
  type ChapterRepairStreamOrchestratorDeps,
} from "./application/ChapterRepairStreamOrchestrator";
import type { ReviewChapterAfterRepair } from "./evaluation/ChapterRepairBaselineEvaluator";

export {
  getChapterRepairLockTableSizeForTests,
  resetChapterRepairLocksForTests,
} from "./concurrency/ChapterRepairLock";
export { loadLatestQualityReportIssues } from "./evaluation/ChapterRepairIssueResolver";
export { buildRepairRunStatusFrame } from "./application/ChapterRepairFinalizer";

export interface ChapterRepairStreamRuntimeDeps {
  assembler?: Pick<GenerationContextAssembler, "assemble">;
  artifactSyncService: Pick<ChapterArtifactSyncService, "syncChapterArtifacts">;
  reviewChapterAfterRepair: ReviewChapterAfterRepair;
  resolveAuditIssues?: (novelId: string, issueIds: string[]) => Promise<unknown>;
  contentCommitService?: ChapterRepairStreamOrchestratorDeps["contentCommitService"];
}

export class ChapterRepairStreamRuntime {
  private readonly orchestrator: ChapterRepairStreamOrchestrator;

  constructor(deps: ChapterRepairStreamRuntimeDeps) {
    this.orchestrator = new ChapterRepairStreamOrchestrator({
      ...deps,
      contentCommitService: deps.contentCommitService ?? new ChapterContentCommitService(),
    });
  }

  createRepairStream(
    novelId: string,
    chapterId: string,
    options: RepairOptions = {},
  ): Promise<{
    stream: AsyncIterable<BaseMessageChunk>;
    onDone: (fullContent: string, helpers: StreamDoneHelpers) => Promise<void>;
  }> {
    return this.orchestrator.createRepairStream(novelId, chapterId, options);
  }
}
