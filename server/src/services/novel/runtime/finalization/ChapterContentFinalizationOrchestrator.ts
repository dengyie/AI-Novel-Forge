import type { ChapterArtifactSyncService } from "../ChapterArtifactSyncService";
import type {
  FinalizeChapterContentInput,
  FinalizeChapterContentResult,
} from "../ChapterContentFinalizationService";
import { ChapterFactProjectionService } from "./ChapterFactProjectionService";
import { ChapterQualityProjectionService } from "./ChapterQualityProjectionService";
import { ChapterStyleReviewFinalizer } from "./ChapterStyleReviewFinalizer";
import { ChapterTimelineProjectionService } from "./ChapterTimelineProjectionService";

export class ChapterContentFinalizationOrchestrator {
  constructor(private readonly deps: {
    styleFinalizer: ChapterStyleReviewFinalizer;
    qualityProjection: ChapterQualityProjectionService;
    timelineProjection: ChapterTimelineProjectionService;
    factProjection: ChapterFactProjectionService;
    artifactSyncService: Pick<ChapterArtifactSyncService, "syncChapterArtifacts">;
    markChapterStatus: (
      chapterId: string,
      status: "pending_review" | "needs_repair",
      expectedContentRevision: number,
    ) => Promise<void>;
    finishTraceRun: (
      runId: string | null,
      contentLength: number,
      startMs: number | null,
    ) => Promise<void>;
  }) {}

  async finalize(input: FinalizeChapterContentInput): Promise<FinalizeChapterContentResult> {
    const { styleReview, committed } = await this.deps.styleFinalizer.finalize(input);
    const projected = await this.deps.qualityProjection.project({
      novelId: input.novelId,
      chapterId: input.chapterId,
      request: input.request,
      contextPackage: input.contextPackage,
      content: committed.content,
      contentRevision: committed.contentRevision,
      lengthControl: input.lengthControl,
      runId: input.runId,
      styleReview,
    });
    await this.deps.markChapterStatus(
      input.chapterId,
      projected.needsRepair ? "needs_repair" : "pending_review",
      committed.contentRevision,
    );

    void this.deps.timelineProjection.schedule({
      novelId: input.novelId,
      chapterId: input.chapterId,
      content: committed.content,
      contextPackage: input.contextPackage,
      request: input.request,
      qualityDebt: projected.needsRepair,
      timelineGate: projected.timelineGate,
    }).catch((error) => {
      console.warn("[chapter-runtime] timeline finalization schedule failed", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    if (!projected.needsRepair) {
      try {
        await this.deps.factProjection.writeAcceptedFacts({
          novelId: input.novelId,
          chapterId: input.chapterId,
          contentRevision: committed.contentRevision,
          runId: input.runId,
          contextPackage: input.contextPackage,
          runtimePackage: projected.runtimePackage,
        });
      } catch (error) {
        console.warn("[chapter-runtime] fact ledger write failed", {
          novelId: input.novelId,
          chapterId: input.chapterId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (
      !projected.needsRepair
      && input.deferArtifactBackgroundSync
      && input.scheduleDeferredArtifactBackgroundSync !== false
    ) {
      await this.deps.artifactSyncService.syncChapterArtifacts(
        input.novelId,
        input.chapterId,
        committed.content,
        {
          scheduleBackgroundSync: true,
          artifactSyncMode: input.request.artifactSyncMode,
          awaitArtifactDelta: true,
          skipLegacySummaryAndFacts: true,
          provider: input.request.provider,
          model: input.request.model,
        },
      );
    }

    await this.deps.finishTraceRun(input.runId, committed.content.length, input.startMs);
    return {
      finalContent: committed.content,
      runtimePackage: projected.runtimePackage,
      styleReview,
      score: projected.score,
      issues: projected.issues,
      contentRevision: committed.contentRevision,
    };
  }
}
