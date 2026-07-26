import type { CommittedChapterContent } from "../content/ChapterContentCommitTypes";
import type { ChapterContentCommitService } from "../content/ChapterContentCommitService";
import {
  PostGenerationStyleReviewRunner,
  type StyleReviewResult,
} from "../PostGenerationStyleReviewRunner";
import type { FinalizeChapterContentInput } from "../ChapterContentFinalizationService";

export class ChapterStyleReviewFinalizer {
  constructor(private readonly deps: {
    contentCommitService: Pick<ChapterContentCommitService, "commit">;
    runner?: Pick<PostGenerationStyleReviewRunner, "run">;
  }) {}

  async finalize(input: FinalizeChapterContentInput): Promise<{
    styleReview: StyleReviewResult;
    committed: CommittedChapterContent;
  }> {
    let styleReview: StyleReviewResult;
    try {
      styleReview = await (this.deps.runner ?? new PostGenerationStyleReviewRunner()).run({
        novelId: input.novelId,
        chapterId: input.chapterId,
        request: input.request,
        contextPackage: input.contextPackage,
        content: input.content,
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
