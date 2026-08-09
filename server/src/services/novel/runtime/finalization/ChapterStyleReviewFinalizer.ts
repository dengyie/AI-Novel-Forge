import type { CommittedChapterContent } from "../content/ChapterContentCommitTypes";
import type { ChapterContentCommitService } from "../content/ChapterContentCommitService";
import {
  PostGenerationStyleReviewRunner,
  type StyleReviewResult,
} from "../PostGenerationStyleReviewRunner";
import type { FinalizeChapterContentInput } from "../ChapterContentFinalizationService";
import { throwIfChapterGenerationAborted } from "../chapterAbortGuard";

export class ChapterStyleReviewFinalizer {
  constructor(private readonly deps: {
    contentCommitService: Pick<ChapterContentCommitService, "commit">;
    runner?: Pick<PostGenerationStyleReviewRunner, "run">;
  }) {}

  async finalize(input: FinalizeChapterContentInput): Promise<{
    styleReview: StyleReviewResult;
    committed: CommittedChapterContent;
  }> {
    throwIfChapterGenerationAborted(input.signal);
    let styleReview: StyleReviewResult;
    try {
      styleReview = await (this.deps.runner ?? new PostGenerationStyleReviewRunner()).run({
        novelId: input.novelId,
        chapterId: input.chapterId,
        request: input.request,
        contextPackage: input.contextPackage,
        content: input.content,
        signal: input.signal,
      });
    } catch (error) {
      console.warn("[chapter-runtime] post-generation style review failed, fallback to raw content", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
      styleReview = {
        report: null,
        residualReport: null,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }
    throwIfChapterGenerationAborted(input.signal);

    if (!styleReview.autoRewritten) {
      return {
        styleReview,
        committed: {
          novelId: input.novelId,
          chapterId: input.chapterId,
          content: input.content,
          contentRevision: input.expectedContentRevision,
        },
      };
    }
    throwIfChapterGenerationAborted(input.signal);
    return {
      styleReview,
      committed: await this.deps.contentCommitService.commit({
        novelId: input.novelId,
        chapterId: input.chapterId,
        content: styleReview.finalContent,
        expectedContentRevision: input.expectedContentRevision,
        source: "style_rewrite",
      }),
    };
  }
}
