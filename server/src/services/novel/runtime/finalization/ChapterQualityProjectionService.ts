import type { ChapterRuntimePackage, GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import { extractSotBannedTermsFromNovel } from "@ai-novel/shared/types/sotBannedTerms";
import { extractBannedTermsFromStyleToneSafe } from "@ai-novel/shared/types/styleToneBannedTerms";
import { prisma } from "../../../../db/prisma";
import { openConflictService } from "../../../state/OpenConflictService";
import { persistChapterQualityScores } from "../../quality/chapterQualityScorePersist";
import type { ChapterRuntimeRequestInput } from "../chapterRuntimeSchema";
import type { ChapterTimelineGateResult } from "../ChapterTimelineFinalizationService";
import { ChapterQualityGateService } from "../ChapterQualityGateService";
import {
  buildRuntimePackage,
  type ChapterRuntimePlannerPort,
} from "../chapterRuntimePackageBuilders";
import type { StyleReviewResult } from "../PostGenerationStyleReviewRunner";
import {
  buildProseQualityAuditReport,
  detectProseQuality,
  normalizeProseQualityTermList,
} from "../proseQuality/ProseQualityDetector";
import { isChapterContentConflictError } from "../../chapterContentCas";
import { throwIfChapterGenerationAborted } from "../chapterAbortGuard";

export interface ChapterQualityProjectionResult {
  runtimePackage: ChapterRuntimePackage;
  score: QualityScore;
  issues: ReviewIssue[];
  needsRepair: boolean;
  timelineGate: ChapterTimelineGateResult;
}

export class ChapterQualityProjectionService {
  constructor(private readonly deps: {
    qualityGateService: Pick<ChapterQualityGateService, "runAcceptanceGateOnly">;
    plannerService: ChapterRuntimePlannerPort;
  }) {}

  async project(input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    contextPackage: GenerationContextPackage;
    content: string;
    contentRevision: number;
    lengthControl?: ChapterRuntimePackage["lengthControl"];
    runId: string | null;
    styleReview: StyleReviewResult;
    signal?: AbortSignal;
  }): Promise<ChapterQualityProjectionResult> {
    throwIfChapterGenerationAborted(input.signal);
    const { acceptance, timelineGate } = await this.deps.qualityGateService.runAcceptanceGateOnly({
      novelId: input.novelId,
      chapterId: input.chapterId,
      contextPackage: input.contextPackage,
      content: input.content,
      request: input.request,
      signal: input.signal,
    });
    throwIfChapterGenerationAborted(input.signal);
    const mustAvoidTerms = normalizeProseQualityTermList(
      input.contextPackage.chapter.mustAvoid ?? null,
    );
    const proseQualityAuditReport = buildProseQualityAuditReport({
      novelId: input.novelId,
      chapterId: input.chapterId,
      report: detectProseQuality(input.content, {
        mustAvoidTerms,
        bannedTerms: await this.loadNovelBannedTerms(input.novelId),
      }),
    });
    const activeOpenConflicts = await openConflictService.listOpenConflicts(input.novelId, {
      beforeChapterOrder: input.contextPackage.chapter.order,
      includeCurrentChapter: true,
      limit: 8,
    });
    const runtimePackage = buildRuntimePackage({
      novelId: input.novelId,
      chapterId: input.chapterId,
      request: input.request,
      contextPackage: input.contextPackage,
      finalContent: input.content,
      lengthControl: input.lengthControl,
      auditResult: {
        score: acceptance.score,
        auditReports: proseQualityAuditReport
          ? [...acceptance.auditReports, proseQualityAuditReport]
          : acceptance.auditReports,
      },
      activeOpenConflicts,
      styleReview: input.styleReview,
      acceptance: acceptance.assessment,
      timelineCheck: timelineGate.result,
      runId: input.runId,
      plannerService: this.deps.plannerService,
    });
    throwIfChapterGenerationAborted(input.signal);
    const needsRepair = acceptance.assessment.status === "repairable"
      || acceptance.assessment.status === "needs_manual_review"
      || timelineGate.result.status === "failed"
      || runtimePackage.audit.hasBlockingIssues;
    await this.persistScores({
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterOrder: input.contextPackage.chapter.order,
      score: acceptance.score,
      issues: acceptance.issues,
      contentRevision: input.contentRevision,
      signal: input.signal,
    });
    return {
      runtimePackage,
      score: acceptance.score,
      issues: acceptance.issues,
      needsRepair,
      timelineGate,
    };
  }

  private async loadNovelBannedTerms(novelId: string): Promise<string[]> {
    try {
      const novel = await prisma.novel.findUnique({
        where: { id: novelId },
        select: {
          storyWorldSliceJson: true,
          storyWorldSliceOverridesJson: true,
          styleTone: true,
        },
      });
      const seen = new Set<string>();
      return [
        ...extractSotBannedTermsFromNovel(novel),
        ...extractBannedTermsFromStyleToneSafe(novel),
      ].filter((term) => {
        if (seen.has(term)) return false;
        seen.add(term);
        return true;
      });
    } catch (error) {
      console.warn("[chapter-runtime] load novel banned terms failed; treating as empty", {
        novelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async persistScores(input: {
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    score: QualityScore;
    issues: ReviewIssue[];
    contentRevision: number;
    signal?: AbortSignal;
  }): Promise<void> {
    throwIfChapterGenerationAborted(input.signal);
    try {
      await persistChapterQualityScores({
        novelId: input.novelId,
        chapterId: input.chapterId,
        score: input.score,
        issues: input.issues,
        expectedContentRevision: input.contentRevision,
        writeReport: false,
      });
    } catch (error) {
      if (isChapterContentConflictError(error)) {
        throw error;
      }
      throwIfChapterGenerationAborted(input.signal);
      console.warn("[chapter-runtime] chapter quality score persist failed", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        const existing = await prisma.chapter.findFirst({
          where: { id: input.chapterId, novelId: input.novelId },
          select: { riskFlags: true },
        });
        let parsed: Record<string, unknown> = {};
        if (existing?.riskFlags?.trim()) {
          try {
            const value = JSON.parse(existing.riskFlags) as unknown;
            if (value && typeof value === "object" && !Array.isArray(value)) {
              parsed = value as Record<string, unknown>;
            }
          } catch {
            parsed = {};
          }
        }
        await prisma.chapter.updateMany({
          where: {
            id: input.chapterId,
            novelId: input.novelId,
            contentRevision: input.contentRevision,
          },
          data: {
            riskFlags: JSON.stringify({
              ...parsed,
              qualityScorePersistFailed: {
                at: new Date().toISOString(),
                chapterOrder: input.chapterOrder,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          },
        });
      } catch {
        // Best-effort observability must not mask the committed chapter.
      }
    }
  }
}
