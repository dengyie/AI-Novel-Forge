import type { ChapterRuntimePackage, GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import { prisma } from "../../../db/prisma";
import { ChapterArtifactSyncService } from "./ChapterArtifactSyncService";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import type { PostGenerationStyleReviewRunner, StyleReviewResult } from "./PostGenerationStyleReviewRunner";
import type { ChapterQualityGateService } from "./ChapterQualityGateService";
import type { ChapterRuntimePlannerPort } from "./chapterRuntimePackageBuilders";
import type { ChapterTimelineFinalizationService } from "./ChapterTimelineFinalizationService";
import { ChapterContentCommitService } from "./content/ChapterContentCommitService";
import { ChapterContentFinalizationOrchestrator } from "./finalization/ChapterContentFinalizationOrchestrator";
import { ChapterFactProjectionService } from "./finalization/ChapterFactProjectionService";
import { ChapterQualityProjectionService } from "./finalization/ChapterQualityProjectionService";
import { ChapterStyleReviewFinalizer } from "./finalization/ChapterStyleReviewFinalizer";
import { ChapterTimelineProjectionService } from "./finalization/ChapterTimelineProjectionService";
import {
  createChapterContentConflictError,
  createChapterNotFoundError,
} from "../chapterContentCas";

export interface ChapterContentFinalizationAgentRuntime {
  finishChapterGenRun: (runId: string, summary: string, durationMs: number) => Promise<void>;
}

export interface ChapterContentFinalizationServiceDeps {
  qualityGateService: Pick<ChapterQualityGateService, "runAcceptanceGateOnly">;
  artifactSyncService: Pick<ChapterArtifactSyncService, "syncChapterArtifacts">;
  contentCommitService?: Pick<ChapterContentCommitService, "commit">;
  plannerService: ChapterRuntimePlannerPort;
  agentRuntime: ChapterContentFinalizationAgentRuntime;
  postGenerationStyleReviewRunner?: Pick<PostGenerationStyleReviewRunner, "run">;
  timelineFinalizer?: Pick<
    ChapterTimelineFinalizationService,
    "finalizeCurrentContent" | "ensurePreviousChapterFinalized"
  >;
}

export interface FinalizeChapterContentInput {
  novelId: string;
  chapterId: string;
  request: ChapterRuntimeRequestInput;
  contextPackage: GenerationContextPackage;
  content: string;
  expectedContentRevision: number;
  lengthControl?: ChapterRuntimePackage["lengthControl"];
  runId: string | null;
  startMs: number | null;
  deferArtifactBackgroundSync?: boolean;
  scheduleDeferredArtifactBackgroundSync?: boolean;
  signal?: AbortSignal;
}

export interface FinalizeChapterContentResult {
  finalContent: string;
  runtimePackage: ChapterRuntimePackage;
  styleReview: StyleReviewResult;
  score: QualityScore;
  issues: ReviewIssue[];
  contentRevision: number;
}

export class ChapterContentFinalizationService {
  private readonly orchestrator: ChapterContentFinalizationOrchestrator;

  constructor(private readonly deps: ChapterContentFinalizationServiceDeps) {
    const contentCommitService = deps.contentCommitService ?? new ChapterContentCommitService();
    this.orchestrator = new ChapterContentFinalizationOrchestrator({
      styleFinalizer: new ChapterStyleReviewFinalizer({
        contentCommitService,
        runner: deps.postGenerationStyleReviewRunner,
      }),
      qualityProjection: new ChapterQualityProjectionService({
        qualityGateService: deps.qualityGateService,
        plannerService: deps.plannerService,
      }),
      timelineProjection: new ChapterTimelineProjectionService(deps.timelineFinalizer),
      factProjection: new ChapterFactProjectionService(),
      artifactSyncService: deps.artifactSyncService,
      markChapterStatus: (chapterId, status, expectedContentRevision) => (
        this.markChapterStatus(chapterId, status, expectedContentRevision)
      ),
      finishTraceRun: (runId, contentLength, startMs) => (
        this.finishTraceRun(runId, contentLength, startMs)
      ),
    });
  }

  finalizeChapterContent(input: FinalizeChapterContentInput): Promise<FinalizeChapterContentResult> {
    return this.orchestrator.finalize(input);
  }

  async finishTraceRun(
    runId: string | null,
    contentLength: number,
    startMs: number | null,
  ): Promise<void> {
    if (!runId || startMs == null) return;
    try {
      await this.deps.agentRuntime.finishChapterGenRun(
        runId,
        `chapter draft generated, ${contentLength} chars`,
        Date.now() - startMs,
      );
    } catch {
      // Trace failures do not change the committed chapter result.
    }
  }

  async markChapterStatus(
    chapterId: string,
    chapterStatus: "pending_generation" | "generating" | "pending_review" | "needs_repair",
    expectedContentRevision?: number,
  ): Promise<void> {
    if (expectedContentRevision == null) {
      await prisma.chapter.update({
        where: { id: chapterId },
        data: { chapterStatus },
      });
      return;
    }
    const projected = await prisma.chapter.updateMany({
      where: { id: chapterId, contentRevision: expectedContentRevision },
      data: { chapterStatus },
    });
    if (projected.count > 0) return;
    const current = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { contentRevision: true },
    });
    if (!current) {
      throw createChapterNotFoundError();
    }
    throw createChapterContentConflictError({
      currentContentRevision: current.contentRevision,
      expectedContentRevision,
    });
  }
}
