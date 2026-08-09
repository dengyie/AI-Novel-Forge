import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { ChapterRuntimeRequestInput } from "../chapterRuntimeSchema";
import { throwIfChapterGenerationAborted } from "../chapterAbortGuard";
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
    expectedContentRevision: number;
    content: string;
    contextPackage: GenerationContextPackage;
    request: ChapterRuntimeRequestInput;
    qualityDebt: boolean;
    timelineGate?: ChapterTimelineGateResult | null;
    signal?: AbortSignal;
  }): Promise<void> {
    throwIfChapterGenerationAborted(input.signal);
    const request = {
      provider: input.request.provider,
      model: input.request.model,
      temperature: input.request.temperature,
    };
    await this.finalizer.ensurePreviousChapterFinalized({
      novelId: input.novelId,
      currentChapterOrder: input.contextPackage.chapter.order,
      request,
      signal: input.signal,
    }).catch((error) => {
      throwIfChapterGenerationAborted(input.signal);
      console.warn("[chapter-runtime] previous chapter timeline finalization failed", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    throwIfChapterGenerationAborted(input.signal);
    await this.finalizer.finalizeCurrentContent({
      novelId: input.novelId,
      chapterId: input.chapterId,
      expectedContentRevision: input.expectedContentRevision,
      content: input.content,
      contextPackage: input.contextPackage,
      request,
      timelineGate: input.timelineGate ?? null,
      qualityDebt: input.qualityDebt,
      sourceStage: "chapter_content_finalization",
      reason: input.qualityDebt ? "post_finalize_with_quality_debt" : "post_finalize_async",
      signal: input.signal,
    });
    throwIfChapterGenerationAborted(input.signal);
  }
}
