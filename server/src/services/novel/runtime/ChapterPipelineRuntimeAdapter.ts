import { prisma } from "../../../db/prisma";
import {
  chapterStatePairAfterDraftSave,
  mergeChapterPatchForGenerationStateBump,
} from "../chapterLifecycleState";
import { ChapterArtifactSyncService } from "./ChapterArtifactSyncService";
import { ChapterContentCommitService } from "./content/ChapterContentCommitService";
import { createChapterContentConflictError, createChapterNotFoundError } from "../chapterContentCas";
import {
  runPipelineChapterWithRuntime,
  type PipelineRuntimeHooks,
  type PipelineRuntimeInput,
  type PipelineRuntimeResult,
} from "./chapterRuntimePipeline";
import {
  isChapterEmptyContentError,
} from "./chapterEmptyContentError";
import { isChapterChineseProseGateError } from "./chapterChineseProseGateError";
import type { ChapterContentFinalizationService } from "./ChapterContentFinalizationService";
import type { ChapterStreamGenerationOrchestrator } from "./ChapterStreamGenerationOrchestrator";
import { throwIfChapterGenerationAborted } from "./chapterAbortGuard";

export interface ChapterPipelineRuntimeAdapterDeps {
  streamOrchestrator: Pick<
    ChapterStreamGenerationOrchestrator,
    "prepareRuntimeChapter" | "generateDraftFromWriter" | "markChapterStatus"
  >;
  artifactSyncService: Pick<ChapterArtifactSyncService, "saveDraftAndArtifacts" | "syncChapterArtifacts">;
  contentCommitService: Pick<ChapterContentCommitService, "commit">;
  contentFinalizationService: Pick<ChapterContentFinalizationService, "finalizeChapterContent">;
  ensureNovelCharacters: (novelId: string, actionName: string, minCount?: number) => Promise<void>;
}

export class ChapterPipelineRuntimeAdapter {
  private readonly deps: ChapterPipelineRuntimeAdapterDeps;

  constructor(deps: ChapterPipelineRuntimeAdapterDeps) {
    this.deps = deps;
  }

  async runPipelineChapter(
    novelId: string,
    chapterId: string,
    options: PipelineRuntimeInput = {},
    hooks: PipelineRuntimeHooks = {},
  ): Promise<PipelineRuntimeResult> {
    throwIfChapterGenerationAborted(options.signal);
    const { request, assembled } = await this.deps.streamOrchestrator.prepareRuntimeChapter(novelId, chapterId, options);
    throwIfChapterGenerationAborted(options.signal);
    await this.deps.streamOrchestrator.markChapterStatus(chapterId, "generating");
    throwIfChapterGenerationAborted(options.signal);
    try {
      return await runPipelineChapterWithRuntime(
        {
          validateRequest: () => request,
          ensureNovelCharacters: this.deps.ensureNovelCharacters,
          assemble: async () => assembled,
          generateDraftFromWriter: (input) => this.deps.streamOrchestrator.generateDraftFromWriter(input),
          saveDraftAndArtifacts: (targetNovelId, targetChapterId, content, generationState, saveOptions) =>
            this.deps.artifactSyncService.saveDraftAndArtifacts(
              targetNovelId,
              targetChapterId,
              content,
              generationState,
              saveOptions,
            ),
          commitRepairContent: (targetNovelId, targetChapterId, content, expectedContentRevision) =>
            this.deps.contentCommitService.commit({
              novelId: targetNovelId,
              chapterId: targetChapterId,
              content,
              expectedContentRevision,
              // 展开 ChapterStatePairPatch 为普通对象以匹配 commit 的
              // statePatch: Record<string, unknown>（与 ChapterRepairFinalizer 同构写法）。
              statePatch: { ...chapterStatePairAfterDraftSave("repaired") },
              source: "pipeline_repair",
            }),
          syncFinalChapterArtifacts: (targetNovelId, targetChapterId, content, syncOptions) =>
            this.deps.artifactSyncService.syncChapterArtifacts(
              targetNovelId,
              targetChapterId,
              content,
              {
                scheduleBackgroundSync: true,
                artifactSyncMode: syncOptions?.artifactSyncMode ?? options.artifactSyncMode,
                contentProvenance: syncOptions?.contentProvenance,
                awaitArtifactDelta: true,
                skipLegacySummaryAndFacts: true,
                provider: request.provider,
                model: request.model,
              },
            ),
          finalizeChapterContent: async (input) => {
            const finalized = await this.deps.contentFinalizationService.finalizeChapterContent({
              ...input,
              deferArtifactBackgroundSync: true,
              scheduleDeferredArtifactBackgroundSync: false,
            });
            return {
              finalContent: finalized.finalContent,
              runtimePackage: finalized.runtimePackage,
              contentRevision: finalized.contentRevision,
            };
          },
          markChapterGenerationState: (targetChapterId, generationState, expectedContentRevision, options) =>
            this.markChapterGenerationState(
              targetChapterId,
              generationState,
              expectedContentRevision,
              options,
            ),
          markChapterNeedsRepair: (targetChapterId, expectedContentRevision) =>
            this.markChapterStatus(targetChapterId, "needs_repair", expectedContentRevision),
        },
        novelId,
        chapterId,
        options,
        hooks,
      );
    } catch (error) {
      throwIfChapterGenerationAborted(options.signal);
      if (isChapterEmptyContentError(error) || isChapterChineseProseGateError(error)) {
        await this.deps.streamOrchestrator.markChapterStatus(chapterId, "pending_generation");
      }
      throw error;
    }
  }

  private async markChapterGenerationState(
    chapterId: string,
    generationState: "reviewed" | "approved",
    expectedContentRevision: number,
    options?: { literaryPass?: boolean; styleClear?: boolean },
  ): Promise<void> {
    const updated = await prisma.chapter.updateMany({
      where: { id: chapterId, contentRevision: expectedContentRevision },
      data: mergeChapterPatchForGenerationStateBump({}, generationState, options),
    });
    if (updated.count === 0) {
      await this.throwContentProjectionConflict(chapterId, expectedContentRevision);
    }
  }

  private async markChapterStatus(
    chapterId: string,
    chapterStatus: "needs_repair",
    expectedContentRevision: number,
  ): Promise<void> {
    const updated = await prisma.chapter.updateMany({
      where: { id: chapterId, contentRevision: expectedContentRevision },
      data: { chapterStatus },
    });
    if (updated.count === 0) {
      await this.throwContentProjectionConflict(chapterId, expectedContentRevision);
    }
  }

  private async throwContentProjectionConflict(
    chapterId: string,
    expectedContentRevision: number,
  ): Promise<never> {
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
