import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { ChapterRuntimeRequestInput } from "../chapterRuntimeSchema";
import {
  chapterTimelineFinalizationService,
  type ChapterTimelineFinalizationService,
  type ChapterTimelineGateResult,
} from "../ChapterTimelineFinalizationService";

export class ChapterTimelineProjectionService {
  constructor(private readonly finalizer: Pick<
    ChapterTimelineFinalizationService,
    "finalizeCurrentContent" | "ensurePreviousChapterFinalized"
  > = chapterTimelineFinalizationService) {}

  async schedule(input: {
    novelId: string;
    chapterId: string;
    content: string;
    contextPackage: GenerationContextPackage;
    request: ChapterRuntimeRequestInput;
    qualityDebt: boolean;
    timelineGate?: ChapterTimelineGateResult | null;
  }): Promise<void> {
    const request = {
      provider: input.request.provider,
      model: input.request.model,
      temperature: input.request.temperature,
    };
    await this.finalizer.ensurePreviousChapterFinalized({
      novelId: input.novelId,
      currentChapterOrder: input.contextPackage.chapter.order,
      request,
    }).catch((error) => {
      console.warn("[chapter-runtime] previous chapter timeline finalization failed", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await this.finalizer.finalizeCurrentContent({
      novelId: input.novelId,
      chapterId: input.chapterId,
      content: input.content,
      contextPackage: input.contextPackage,
      request,
      timelineGate: input.timelineGate ?? null,
      qualityDebt: input.qualityDebt,
      sourceStage: "chapter_content_finalization",
      reason: input.qualityDebt ? "post_finalize_with_quality_debt" : "post_finalize_async",
    });
  }
}
