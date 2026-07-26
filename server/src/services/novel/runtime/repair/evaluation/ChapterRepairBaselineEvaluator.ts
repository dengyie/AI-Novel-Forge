import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import type { RepairOptions, ReviewOptions } from "../../../novelCoreShared";
import { logPipelineError, ruleScore } from "../../../novelCoreShared";
import { assertRepairAbortSignal } from "../concurrency/ChapterRepairCancellation";

export interface RepairReviewResult {
  score: QualityScore;
  issues: ReviewIssue[];
  degraded?: boolean;
}

export type ReviewChapterAfterRepair = (
  novelId: string,
  chapterId: string,
  options: ReviewOptions,
) => Promise<RepairReviewResult>;

function scoreFromChapterColumns(chapter: {
  qualityScore?: number | null;
  continuityScore?: number | null;
  characterScore?: number | null;
  pacingScore?: number | null;
} | null | undefined): QualityScore | null {
  if (
    chapter?.qualityScore == null
    || chapter.continuityScore == null
    || chapter.characterScore == null
    || chapter.pacingScore == null
  ) {
    return null;
  }
  const overall = chapter.qualityScore;
  return {
    coherence: chapter.continuityScore,
    repetition: overall,
    pacing: chapter.pacingScore,
    voice: chapter.characterScore,
    engagement: overall,
    overall,
  };
}

export class ChapterRepairBaselineEvaluator {
  constructor(private readonly reviewChapterAfterRepair: ReviewChapterAfterRepair) {}

  async evaluate(input: {
    novelId: string;
    chapterId: string;
    baselineContent: string;
    chapter: {
      qualityScore?: number | null;
      continuityScore?: number | null;
      characterScore?: number | null;
      pacingScore?: number | null;
    };
    options: RepairOptions;
  }): Promise<RepairReviewResult> {
    if (!input.baselineContent.trim()) {
      return { score: ruleScore(""), issues: [] };
    }

    try {
      return await this.reviewChapterAfterRepair(input.novelId, input.chapterId, {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature,
        content: input.baselineContent,
        evaluateOnly: true,
        signal: input.options.signal,
      });
    } catch (error) {
      if (input.options.signal?.aborted) {
        throw error;
      }
      logPipelineError("Baseline evaluateOnly failed; falling back to columns/ruleScore.", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    assertRepairAbortSignal("baseline-evaluate-fallback", input.options.signal);

    const fromColumns = scoreFromChapterColumns(input.chapter);
    if (fromColumns) {
      return { score: fromColumns, issues: [], degraded: true };
    }
    return { score: ruleScore(input.baselineContent), issues: [], degraded: true };
  }
}
