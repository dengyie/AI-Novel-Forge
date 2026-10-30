import { readPlanningFactFingerprint, recordPlanningFactFingerprint, type ChapterPlanFactRefresh } from "../planning/ChapterPlanFactRefresh";
import { ChapterTaskSheetQualityGateError } from "./ChapterTaskSheetQualityGateService";
import { reviewChapterExecutionContinuity } from "./chapterExecutionContinuity";
import type { Prisma } from "@prisma/client";
import { parseChapterScenePlan, serializeChapterScenePlan } from "@ai-novel/shared/types/chapterLengthControl";
import {
  assessChapterExecutionContractShape,
  containsInternalQualityCodes,
  formatChapterTaskSheetQualityFailure,
  stripInternalQualityCodes,
} from "@ai-novel/shared/types/chapterTaskSheetQuality";
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import { prisma } from "../../../db/prisma";
import type { StyleBindingService } from "../../styleEngine/StyleBindingService";
import { buildWriterStyleContractText } from "../../styleEngine/styleContractText";
import { logPipelineWarn } from "../novelCoreShared";
import type { StoryMacroPlanService } from "../storyMacro/StoryMacroPlanService";
import type { VolumeGenerateOptions } from "./volumeModels";
import { generateVolumePlanDocument } from "./volumeGenerationOrchestrator";
import {
  persistActiveVolumeWorkspace,
  runVolumeWorkspaceTransaction,
} from "./volumeWorkspacePersistence";
import { serializeVolumeWorkspaceDocument } from "./volumeWorkspaceDocument";

export interface ChapterExecutionContractServiceDeps {
  storyMacroPlanService: Pick<StoryMacroPlanService, "getPlan">;
  styleBindingService: Pick<StyleBindingService, "resolveForGeneration">;
  ensureVolumeWorkspace: (novelId: string) => Promise<VolumePlanDocument>;
  findVolumeChapterMatch: (
    workspace: VolumePlanDocument,
    chapter: { order: number; title: string },
  ) => { volumeId: string; volumeChapterId: string };
  ensureActiveVersionRecord: (
    tx: Prisma.TransactionClient,
    novelId: string,
    document: VolumePlanDocument,
    diffSummary?: string,
  ) => Promise<{ versionId: string; version: number }>;
  emitVolumeUpdated: (novelId: string, reason: "chapter_execution_contract_refined") => void;
}

export type EnsureChapterExecutionContractOptions = Pick<
  VolumeGenerateOptions,
  "provider" | "model" | "temperature" | "guidance" | "chapterTaskSheetQualityMode" | "entrypoint" | "taskId" | "signal"
> & {
  taskStyleProfileId?: string;
  factRefresh?: ChapterPlanFactRefresh;
};

export class ChapterExecutionContractService {
  constructor(private readonly deps: ChapterExecutionContractServiceDeps) {}

  async ensureChapterExecutionContract(
    novelId: string,
    chapterId: string,
    options: EnsureChapterExecutionContractOptions = {},
  ) {
    // 写前连续性核对读取到的前章正文快照；持久化前复核是否被并发修改。
    let reviewedPrevious: { order: number; content: string } | null = null;
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: {
        id: true,
        novelId: true,
        title: true,
        order: true,
        targetWordCount: true,
        conflictLevel: true,
        revealLevel: true,
        mustAvoid: true,
        taskSheet: true,
        sceneCards: true,
        content: true,
        contentRevision: true,
        expectation: true,
        chapterStatus: true,
        generationState: true,
        repairHistory: true,
        qualityScore: true,
        continuityScore: true,
        characterScore: true,
        pacingScore: true,
        riskFlags: true,
        hook: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!chapter) {
      throw new Error("章节不存在。");
    }

    const existingScenePlan = parseChapterScenePlan(chapter.sceneCards, {
      targetWordCount: chapter.targetWordCount ?? undefined,
    });
    const needsFactRefresh = options.factRefresh !== undefined
      && readPlanningFactFingerprint(chapter.riskFlags) !== options.factRefresh.fingerprint;
    if (
      !needsFactRefresh
      && typeof chapter.conflictLevel === "number"
      && typeof chapter.revealLevel === "number"
      && typeof chapter.targetWordCount === "number"
      && chapter.mustAvoid?.trim()
      && chapter.taskSheet?.trim()
      && existingScenePlan
    ) {
      // 形状门禁（VolumeChapterSyncService.assertSyncableChapterExecutionContracts）按卷文档章条目
      // 要求 purpose/exclusiveEvent/endingState/nextChapterEntryState 全非空——这四个规划字段没有 Chapter
      // 行来源。仅当卷文档对应章条目四字段齐全时才算"可复用合同"，否则落穿到重新生成（连带再生四项）。
      const workspace = await this.deps.ensureVolumeWorkspace(novelId);
      const matched = this.deps.findVolumeChapterMatch(workspace, {
        order: chapter.order,
        title: chapter.title,
      });
      const targetChapter = workspace.volumes
        .find((volume) => volume.id === matched.volumeId)
        ?.chapters
        .find((item) => item.id === matched.volumeChapterId);
      const planningFieldsComplete = Boolean(
        targetChapter?.purpose?.trim()
        && targetChapter?.exclusiveEvent?.trim()
        && targetChapter?.endingState?.trim()
        && targetChapter?.nextChapterEntryState?.trim()
      );
      if (planningFieldsComplete) {
        // 写前连续性核对（上游 2026-10-17 移植）：形状齐全 ≠ 承接了实际前文。
        // 尚无正文的章节在复用已有合同前，先对上一章已保存正文做一次语义核对；
        // 相同有效输入复用核对结果，AI 要求修订时把指导送回现有合同生成链。
        // CHAPTER_EXECUTION_CONTINUITY_REVIEW=0 为生产逃生开关（回退到无核对的旧行为）。
        let continuityGuidance: string | null = null;
        const continuityReviewEnabled = process.env.CHAPTER_EXECUTION_CONTINUITY_REVIEW !== "0";
        if (
          continuityReviewEnabled
          && !chapter.content?.trim()
          && chapter.order > 1
        ) {
          const previous = await prisma.chapter.findFirst({
            where: { novelId, order: chapter.order - 1 },
            select: { order: true, title: true, content: true },
          });
          if (previous?.content?.trim()) {
            reviewedPrevious = { order: previous.order, content: previous.content };
            const reviewMode = options.chapterTaskSheetQualityMode
              ?? (options.entrypoint === "auto_director" ? "full_book_autopilot" : "ai_copilot");
            const checked = await reviewChapterExecutionContinuity(
              {
                novelId,
                volumeId: matched.volumeId,
                chapterId,
                chapterOrder: chapter.order,
                title: chapter.title,
                summary: targetChapter?.summary ?? null,
                purpose: targetChapter?.purpose ?? null,
                exclusiveEvent: targetChapter?.exclusiveEvent ?? null,
                endingState: targetChapter?.endingState ?? null,
                nextChapterEntryState: targetChapter?.nextChapterEntryState ?? null,
                conflictLevel: chapter.conflictLevel,
                revealLevel: chapter.revealLevel,
                targetWordCount: chapter.targetWordCount,
                mustAvoid: chapter.mustAvoid,
                taskSheet: chapter.taskSheet,
                sceneCards: chapter.sceneCards,
                previousChapterResult: {
                  chapterOrder: previous.order,
                  title: previous.title,
                  content: previous.content,
                },
              },
              {
                provider: options.provider,
                model: options.model,
                temperature: options.temperature,
                taskId: options.taskId,
                entrypoint: options.entrypoint,
                signal: options.signal,
                mode: reviewMode,
              },
            );
            if (checked) {
              const { assessment, result } = checked;
              if (!assessment) {
                // 形状阶段已判不可执行（语义未运行）→ 沿用既有 gate 失败语义。
                if (!result.canEnterExecution) {
                  throw new ChapterTaskSheetQualityGateError(result);
                }
              } else if (
                assessment.verdict === "unusable"
                || assessment.recommendedHandling === "replan_window"
              ) {
                // 硬阻断：unusable 直接拒；replan_window 沿用 contract_overloaded 失败分类路由整窗重排。
                throw new ChapterTaskSheetQualityGateError(result);
              } else if (assessment.recommendedHandling !== "use_as_is") {
                // repair_contract：autopilot 走「带指导重生成」一次有界自愈；
                // 副驾/手动需作者确认，不静默覆盖规划（上游同款语义）。
                if (reviewMode !== "full_book_autopilot") {
                  throw new ChapterTaskSheetQualityGateError(result);
                }
                continuityGuidance = [
                  result.summary,
                  ...result.repairGuidance,
                  ...result.issues.map((issue) => issue.repairHint),
                ].filter(Boolean).join("\n");
              } else if (!result.canEnterExecution) {
                // use_as_is 但未通过（如 safeToSync=false 的矛盾输出）→ 按 gate 失败处理。
                throw new ChapterTaskSheetQualityGateError(result);
              }
            }
          }
        }
        if (!continuityGuidance) {
          const styleContract = await this.resolveStyleContract(
            novelId,
            chapterId,
            options.taskStyleProfileId,
            chapter.order,
          );
          return {
            ...chapter,
            styleContract,
          };
        }
        // 需要协调：把核对结果作为修订指导走现有合同生成链，不添加额外生成循环。
        options = {
          ...options,
          guidance: [
            options.guidance,
            "上一章实际正文与本章规划需要协调，保留本章目标并按以下核对结果修订入口、场景和收尾：",
            continuityGuidance,
          ].filter(Boolean).join("\n"),
        };
      }
    }

    const workspace = await this.deps.ensureVolumeWorkspace(novelId);
    const matched = this.deps.findVolumeChapterMatch(workspace, {
      order: chapter.order,
      title: chapter.title,
    });
    const generatedDocument = await generateVolumePlanDocument({
      novelId,
      workspace,
      options: {
        ...options,
        scope: "chapter_detail",
        detailMode: "task_sheet",
        targetVolumeId: matched.volumeId,
        targetChapterId: matched.volumeChapterId,
        chapterTaskSheetQualityMode: options.chapterTaskSheetQualityMode
          ?? (options.entrypoint === "auto_director" ? "full_book_autopilot" : "ai_copilot"),
      },
      storyMacroPlanService: this.deps.storyMacroPlanService,
    });

    const targetVolume = generatedDocument.volumes.find((volume) => volume.id === matched.volumeId);
    const targetChapter = targetVolume?.chapters.find((item) => item.id === matched.volumeChapterId);
    if (!targetChapter?.taskSheet?.trim() || !targetChapter.sceneCards?.trim()) {
      throw new Error("AI 未返回完整的章节执行合同。");
    }
    const rawTaskSheet = targetChapter.taskSheet.trim();
    const hadInternalCodes = containsInternalQualityCodes(rawTaskSheet);
    const taskSheet = stripInternalQualityCodes(rawTaskSheet);
    if (hadInternalCodes) {
      logPipelineWarn("chapter_execution_contract_stripped_internal_codes", {
        novelId,
        chapterId,
        chapterOrder: chapter.order,
        rawLength: rawTaskSheet.length,
        cleanedLength: taskSheet.length,
      });
    }
    if (!taskSheet.trim()) {
      throw new Error("章节任务单在清洗内部质量 code 后为空，无法进入执行。");
    }
    targetChapter.taskSheet = taskSheet;
    const scenePlan = parseChapterScenePlan(targetChapter.sceneCards, {
      targetWordCount: targetChapter.targetWordCount ?? chapter.targetWordCount ?? undefined,
    });
    if (!scenePlan) {
      throw new Error("章节执行合同中的场景预算无效。");
    }
    const finalQuality = assessChapterExecutionContractShape({
      novelId,
      volumeId: matched.volumeId,
      chapterId,
      chapterOrder: chapter.order,
      title: chapter.title,
      summary: targetChapter.summary,
      purpose: targetChapter.purpose,
      exclusiveEvent: targetChapter.exclusiveEvent,
      endingState: targetChapter.endingState,
      nextChapterEntryState: targetChapter.nextChapterEntryState,
      conflictLevel: targetChapter.conflictLevel,
      revealLevel: targetChapter.revealLevel,
      targetWordCount: targetChapter.targetWordCount,
      mustAvoid: targetChapter.mustAvoid,
      payoffRefs: targetChapter.payoffRefs,
      taskSheet,
      sceneCards: serializeChapterScenePlan(scenePlan),
    });
    if (!finalQuality.canEnterExecution) {
      throw new Error(formatChapterTaskSheetQualityFailure(finalQuality));
    }

    const styleContract = await this.resolveStyleContract(
      novelId,
      chapterId,
      options.taskStyleProfileId,
      chapter.order,
    );
    targetChapter.styleContract = styleContract;

    const persistedChapter = await runVolumeWorkspaceTransaction(async (tx) => {
      // Claim the exact planning snapshot before any workspace/version mutation.
      const claim = await tx.chapter.updateMany({
        where: { id: chapterId, novelId, updatedAt: chapter.updatedAt, contentRevision: chapter.contentRevision },
        data: { updatedAt: new Date() },
      });
      if (claim.count !== 1) throw new Error("章节规划在生成期间发生变化，请重新读取后刷新执行合同。");
      if (reviewedPrevious) {
        const source = await tx.chapter.findFirst({
          where: { novelId, order: reviewedPrevious.order },
          select: { content: true },
        });
        if (source?.content !== reviewedPrevious.content) {
          throw new Error("前章正文在规划核对期间发生变化，请重新准备本章。");
        }
      }
      const current = await tx.chapter.findUnique({ where: { id: chapterId }, select: { riskFlags: true } });
      const { versionId } = await this.deps.ensureActiveVersionRecord(
        tx,
        novelId,
        generatedDocument,
        `刷新第${chapter.order}章执行合同。`,
      );
      const persistedDocument = {
        ...generatedDocument,
        activeVersionId: versionId,
        source: "volume" as const,
      };
      await tx.volumePlanVersion.update({
        where: { id: versionId },
        data: {
          contentJson: serializeVolumeWorkspaceDocument(persistedDocument),
        },
      });
      await persistActiveVolumeWorkspace(tx, novelId, persistedDocument, versionId);
      const updatedChapter = await tx.chapter.update({
        where: { id: chapterId },
        data: {
          targetWordCount: targetChapter.targetWordCount ?? chapter.targetWordCount ?? null,
          conflictLevel: targetChapter.conflictLevel ?? chapter.conflictLevel ?? null,
          revealLevel: targetChapter.revealLevel ?? chapter.revealLevel ?? null,
          mustAvoid: targetChapter.mustAvoid ?? chapter.mustAvoid ?? null,
          taskSheet,
          ...(options.factRefresh ? { riskFlags: recordPlanningFactFingerprint(current?.riskFlags, options.factRefresh.fingerprint) } : {}),
          sceneCards: serializeChapterScenePlan(scenePlan),
        },
      });
      return {
        ...updatedChapter,
        styleContract,
      };
    });

    this.deps.emitVolumeUpdated(novelId, "chapter_execution_contract_refined");
    return persistedChapter;
  }

  private async resolveStyleContract(
    novelId: string,
    chapterId: string,
    taskStyleProfileId?: string,
    chapterOrder?: number | null,
  ): Promise<string | null> {
    const resolvedStyleContext = await this.deps.styleBindingService.resolveForGeneration({
      novelId,
      chapterId,
      taskStyleProfileId,
    }).catch(() => null);
    return buildWriterStyleContractText(
      resolvedStyleContext?.compiledBlocks?.contract ?? null,
      { chapterOrder },
    ) || null;
  }
}
