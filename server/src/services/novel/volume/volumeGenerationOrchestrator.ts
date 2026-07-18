import type {
  VolumeGenerationScope,
  VolumePlanDocument,
} from "@ai-novel/shared/types/novel";
import { prisma } from "../../../db/prisma";
import { runStructuredPrompt } from "../../../prompting/core/promptRunner";
import {
  volumeChapterBoundaryPrompt,
  volumeChapterPurposePrompt,
} from "../../../prompting/prompts/novel/volume/chapterDetail.prompts";
import {
  buildVolumeChapterDetailContextBlocks,
  buildVolumeRebalanceContextBlocks,
  buildVolumeSkeletonContextBlocks,
  buildVolumeSkeletonCritiqueContextBlocks,
  buildVolumeStrategyContextBlocks,
  buildVolumeStrategyCritiqueContextBlocks,
} from "../../../prompting/prompts/novel/volume/contextBlocks";
import { volumeRebalancePrompt } from "../../../prompting/prompts/novel/volume/rebalance.prompts";
import { createVolumeSkeletonPrompt } from "../../../prompting/prompts/novel/volume/skeleton.prompts";
import { volumeSkeletonCritiquePrompt } from "../../../prompting/prompts/novel/volume/skeletonCritique.prompts";
import {
  createVolumeStrategyPrompt,
  volumeStrategyCritiquePrompt,
} from "../../../prompting/prompts/novel/volume/strategy.prompts";
import { buildStoryModePromptBlock, normalizeStoryModeOutput } from "../../storyMode/storyModeProfile";
import type { StoryMacroPlanService } from "../storyMacro/StoryMacroPlanService";
import {
  inferRequiredChapterCountFromBeatSheet,
  resolveTargetChapterCount,
} from "./volumeBeatSheetChapterBudget";
import { generateBeatChunkedChapterList } from "./volumeChapterListGeneration";
import { normalizeVolumeDraftContextInput } from "./volumeDraftContext";
import {
  allocateChapterBudgets,
  assertScopeReadiness,
  deriveChapterBudget,
  generateChapterTaskSheetDetail,
  getBeatSheet,
  getTargetChapter,
  getTargetVolume,
  mergeChapterDetail,
  mergeCritiqueReport,
  mergeRebalance,
  mergeSkeleton,
  mergeStrategyPlan,
  normalizeScope,
  shouldRegenerateSkeleton,
  formatSkeletonCritiqueFeedback,
} from "./volumeGenerationHelpers";
import type {
  VolumeGenerateOptions,
  VolumeGenerationPhase,
  VolumeGenerationNovel,
  VolumeWorkspace,
} from "./volumeModels";
import { buildVolumeWorkspaceDocument } from "./volumeWorkspaceDocument";
import { formatChapterDetailModeLabel } from "./chapterDetailModeLabel";
import {
  generateBeatSheet,
  resolveBeatSheetTargetChapterCount,
} from "./volumeBeatSheetGeneration";
import {
  applyFunctionTablePostChapterList,
  resolveSettingQualityModeFromOptions,
} from "./volumeFunctionCoverage";
import { functionAcceptanceStatusService } from "./FunctionAcceptanceStatusService";
import { normalizeFunctionAcceptanceTable } from "@ai-novel/shared/types/functionAcceptance";
import {
  MAX_VOLUME_COUNT,
  buildVolumeCountGuidance,
} from "@ai-novel/shared/types/volumePlanning";

type StoryMacroPlanResult = Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;

async function notifyVolumeGenerationPhase(input: {
  novelId: string;
  scope: VolumeGenerationScope;
  phase: VolumeGenerationPhase;
  label: string;
  options: VolumeGenerateOptions;
}): Promise<void> {
  console.info(
    `[volume.generate] event=phase_start novelId=${input.novelId} scope=${input.scope} phase=${input.phase} label=${JSON.stringify(input.label)}`,
  );
  await input.options.onPhaseStart?.({
    scope: input.scope,
    phase: input.phase,
    label: input.label,
  });
}

async function loadGenerationContext(params: {
  novelId: string;
  workspace: VolumeWorkspace;
  storyMacroPlanService: Pick<StoryMacroPlanService, "getPlan">;
}): Promise<{
  novel: VolumeGenerationNovel;
  storyMacroPlan: StoryMacroPlanResult;
}> {
  const { novelId, storyMacroPlanService } = params;
  const [rawNovel, storyMacroPlan] = await Promise.all([
    prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        title: true,
        description: true,
        targetAudience: true,
        bookSellingPoint: true,
        competingFeel: true,
        first30ChapterPromise: true,
        commercialTagsJson: true,
        estimatedChapterCount: true,
        defaultChapterLength: true,
        narrativePov: true,
        pacePreference: true,
        emotionIntensity: true,
        primaryStoryMode: {
          select: {
            id: true,
            name: true,
            description: true,
            template: true,
            parentId: true,
            profileJson: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        secondaryStoryMode: {
          select: {
            id: true,
            name: true,
            description: true,
            template: true,
            parentId: true,
            profileJson: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        genre: {
          select: { name: true },
        },
        characters: {
          orderBy: { createdAt: "asc" },
          select: {
            name: true,
            role: true,
            currentGoal: true,
            currentState: true,
          },
        },
      },
    }),
    storyMacroPlanService.getPlan(novelId).catch(() => null),
  ]);

  if (!rawNovel) {
    throw new Error("小说不存在。");
  }

  const novel: VolumeGenerationNovel = {
    ...rawNovel,
    storyModePromptBlock: buildStoryModePromptBlock({
      primary: rawNovel.primaryStoryMode ? normalizeStoryModeOutput(rawNovel.primaryStoryMode) : null,
      secondary: rawNovel.secondaryStoryMode ? normalizeStoryModeOutput(rawNovel.secondaryStoryMode) : null,
    }),
  };

  return {
    novel,
    storyMacroPlan,
  };
}

async function generateStrategy(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const chapterBudget = deriveChapterBudget({ novel, workspace, options });
  const volumeCountGuidance = buildVolumeCountGuidance({
    chapterBudget,
    existingVolumeCount: workspace.volumes.length,
    respectExistingVolumeCount: options.respectExistingVolumeCount,
    userPreferredVolumeCount: options.userPreferredVolumeCount,
    maxVolumeCount: MAX_VOLUME_COUNT,
  });
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "strategy",
    phase: "prompt",
    label: "正在生成卷战略",
    options,
  });
  const generated = await runStructuredPrompt({
    asset: createVolumeStrategyPrompt({
      maxVolumeCount: MAX_VOLUME_COUNT,
      allowedVolumeCountRange: volumeCountGuidance.allowedVolumeCountRange,
      fixedRecommendedVolumeCount: volumeCountGuidance.userPreferredVolumeCount,
      hardPlannedVolumeRange: volumeCountGuidance.hardPlannedVolumeRange,
    }),
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      guidance: options.guidance,
      volumeCountGuidance,
    },
    contextBlocks: buildVolumeStrategyContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      guidance: options.guidance,
      volumeCountGuidance,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.3,
      novelId: document.novelId,
      taskId: options.taskId,
      stage: "volume_strategy",
      itemKey: "volume_strategy",
      scope: "strategy",
      entrypoint: options.entrypoint,
      signal: options.signal,
    },
  });
  return mergeStrategyPlan(document, generated.output);
}

async function generateStrategyCritique(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  if (!document.strategyPlan) {
    throw new Error("请先生成卷战略建议。");
  }
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "strategy_critique",
    phase: "prompt",
    label: "正在评估卷战略",
    options,
  });
  const generated = await runStructuredPrompt({
    asset: volumeStrategyCritiquePrompt,
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      guidance: options.guidance,
    },
    contextBlocks: buildVolumeStrategyCritiqueContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      guidance: options.guidance,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.2,
      novelId: document.novelId,
      taskId: options.taskId,
      stage: "volume_strategy",
      itemKey: "volume_strategy",
      scope: "strategy_critique",
      entrypoint: options.entrypoint,
      signal: options.signal,
    },
  });
  return mergeCritiqueReport(document, generated.output);
}

async function generateSkeletonCritique(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "skeleton_critique",
    phase: "prompt",
    label: "正在审查卷骨架对手面与 framing",
    options,
  });
  const generated = await runStructuredPrompt({
    asset: volumeSkeletonCritiquePrompt,
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      skeletonVolumes: document.volumes,
      guidance: options.guidance,
    },
    contextBlocks: buildVolumeSkeletonCritiqueContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      skeletonVolumes: document.volumes,
      guidance: options.guidance,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.2,
      novelId: document.novelId,
      taskId: options.taskId,
      stage: "volume_strategy",
      itemKey: "volume_skeleton",
      scope: "skeleton_critique",
      entrypoint: options.entrypoint,
      signal: options.signal,
    },
  });
  return mergeCritiqueReport(document, generated.output);
}

async function generateSkeleton(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  if (!document.strategyPlan) {
    throw new Error("请先生成卷战略建议。");
  }
  const chapterBudget = deriveChapterBudget({ novel, workspace, options });
  const volumeCountGuidance = buildVolumeCountGuidance({
    chapterBudget,
    existingVolumeCount: workspace.volumes.length,
    respectExistingVolumeCount: options.respectExistingVolumeCount,
    userPreferredVolumeCount: options.userPreferredVolumeCount,
    maxVolumeCount: MAX_VOLUME_COUNT,
  });
  const targetVolumeCount = document.strategyPlan.recommendedVolumeCount;
  const skeletonCritiqueGuidance = [
    options.guidance?.trim(),
    formatSkeletonCritiqueFeedback(document.critiqueReport),
  ].filter(Boolean).join("\n");

  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "skeleton",
    phase: "prompt",
    label: "正在生成卷骨架",
    options,
  });
  const generated = await runStructuredPrompt({
    asset: createVolumeSkeletonPrompt(targetVolumeCount),
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      guidance: skeletonCritiqueGuidance,
      volumeCountGuidance,
      chapterBudget,
    },
    contextBlocks: buildVolumeSkeletonContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      guidance: skeletonCritiqueGuidance,
      volumeCountGuidance,
      chapterBudget,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.35,
      novelId: document.novelId,
      taskId: options.taskId,
      stage: "volume_strategy",
      itemKey: "volume_skeleton",
      scope: "skeleton",
      entrypoint: options.entrypoint,
      signal: options.signal,
    },
  });
  let merged = mergeSkeleton(document, generated.output.volumes);

  const MAX_SKELETON_GENERATIONS = 2;
  let generations = 1;
  while (generations < MAX_SKELETON_GENERATIONS) {
    merged = await generateSkeletonCritique({
      document: merged,
      novel,
      workspace,
      storyMacroPlan,
      options,
    });
    if (!shouldRegenerateSkeleton(merged.critiqueReport)) {
      return merged;
    }
    generations += 1;

    const retryGuidance = [
      options.guidance?.trim(),
      formatSkeletonCritiqueFeedback(merged.critiqueReport),
    ].filter(Boolean).join("\n");

    await notifyVolumeGenerationPhase({
      novelId: document.novelId,
      scope: "skeleton",
      phase: "prompt",
      label: `卷骨架对手面审查未通过，正在带反馈重生（第 ${generations} 次）`,
      options,
    });
    const regenerated = await runStructuredPrompt({
      asset: createVolumeSkeletonPrompt(targetVolumeCount),
      promptInput: {
        novel,
        workspace,
        storyMacroPlan,
        strategyPlan: document.strategyPlan,
        guidance: retryGuidance,
        volumeCountGuidance,
        chapterBudget,
      },
      contextBlocks: buildVolumeSkeletonContextBlocks({
        novel,
        workspace,
        storyMacroPlan,
        strategyPlan: document.strategyPlan,
        guidance: retryGuidance,
        volumeCountGuidance,
        chapterBudget,
      }),
      options: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature ?? 0.35,
        novelId: document.novelId,
        taskId: options.taskId,
        stage: "volume_strategy",
        itemKey: "volume_skeleton",
        scope: "skeleton",
        entrypoint: options.entrypoint,
        signal: options.signal,
      },
    });
    // 保留最新一轮 critique 报告，便于落库可观测。
    const previousCritiqueReport = merged.critiqueReport;
    merged = mergeSkeleton(merged, regenerated.output.volumes);
    merged = mergeCritiqueReport(merged, previousCritiqueReport);
  }

  // 走到上限仍未通过：再跑一次 critique 拿到最终报告，带 warn 落库，不抛错。
  merged = await generateSkeletonCritique({
    document: merged,
    novel,
    workspace,
    storyMacroPlan,
    options,
  });
  if (shouldRegenerateSkeleton(merged.critiqueReport)) {
    await notifyVolumeGenerationPhase({
      novelId: document.novelId,
      scope: "skeleton",
      phase: "warn",
      label: "卷骨架对手面审查未完全通过，已带风险落库；可在分卷面板查看 critique 报告后手动重生",
      options,
    });
  }
  return merged;
}

export { resolveBeatSheetTargetChapterCount, generateSkeleton, generateSkeletonCritique };

async function generateRebalance(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const anchorVolume = getTargetVolume(document, options.targetVolumeId);
  const anchorIndex = document.volumes.findIndex((volume) => volume.id === anchorVolume.id);
  const previousVolume = anchorIndex > 0 ? document.volumes[anchorIndex - 1] : undefined;
  const nextVolume = anchorIndex >= 0 && anchorIndex < document.volumes.length - 1 ? document.volumes[anchorIndex + 1] : undefined;
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "rebalance",
    phase: "prompt",
    label: `正在校准第 ${anchorVolume.sortOrder} 卷与相邻卷衔接`,
    options,
  });
  const generated = await runStructuredPrompt({
    asset: volumeRebalancePrompt,
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      anchorVolume,
      previousVolume,
      nextVolume,
      guidance: options.guidance,
    },
    contextBlocks: buildVolumeRebalanceContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      anchorVolume,
      previousVolume,
      nextVolume,
      guidance: options.guidance,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.25,
      novelId: document.novelId,
      volumeId: anchorVolume.id,
      taskId: options.taskId,
      stage: "structured_outline",
      itemKey: "chapter_list",
      scope: "rebalance",
      entrypoint: options.entrypoint,
      signal: options.signal,
    },
  });
  return mergeRebalance(document, anchorVolume.id, generated.output.decisions);
}

async function generateChapterList(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const targetVolume = getTargetVolume(document, options.targetVolumeId);
  const { mergedDocument, mergedWorkspace } = await generateBeatChunkedChapterList({
    document,
    novel,
    workspace,
    storyMacroPlan,
    options,
    notifyPhase: async (label) => notifyVolumeGenerationPhase({
      novelId: document.novelId,
      scope: "chapter_list",
      phase: "prompt",
      label,
      options,
    }),
    notifyIntermediateDocument: options.persistIntermediateDocuments === true && options.onIntermediateDocument
      ? async (event) => {
        if (event.isFinal === false) {
          await options.onIntermediateDocument?.(event);
        }
      }
      : undefined,
  });
  const rebalancedDocument = await generateRebalance({
    document: mergedDocument,
    novel,
    workspace: mergedWorkspace,
    storyMacroPlan,
    options: {
      ...options,
      scope: "rebalance",
      targetVolumeId: targetVolume.id,
    },
  });
  const settingQualityMode = resolveSettingQualityModeFromOptions(options.settingQualityMode);
  const { document: withFunctionCoverage } = applyFunctionTablePostChapterList({
    document: rebalancedDocument,
    volumeId: targetVolume.id,
    mode: settingQualityMode,
    mergeMustAvoid: true,
  });
  await options.onIntermediateDocument?.({
    scope: "chapter_list",
    document: withFunctionCoverage,
    isFinal: true,
    targetVolumeId: targetVolume.id,
    targetBeatKey: options.targetBeatKey,
    generationMode: options.generationMode,
  });
  return withFunctionCoverage;
}

/**
 * 导入/写入功能验收表（B2）。
 * 不跑 LLM；source=generated 时仍可写入但 enforce 门禁会拒绝。
 */
function upsertFunctionTable(params: {
  document: VolumePlanDocument;
  options: VolumeGenerateOptions;
}): VolumePlanDocument {
  const { document, options } = params;
  const targetVolume = getTargetVolume(document, options.targetVolumeId);
  const raw = options.functionAcceptanceTable;
  if (!raw) {
    // 无输入时若已有表则原样；否则建空 generated 占位提示调用方
    const existing = document.functionAcceptanceTables?.find((table) => table.volumeId === targetVolume.id);
    if (existing) {
      return document;
    }
    throw new Error("缺少 functionAcceptanceTable 输入，无法写入功能验收表。");
  }
  const normalized = normalizeFunctionAcceptanceTable(
    {
      ...raw,
      volumeId: raw.volumeId?.trim() || targetVolume.id,
    },
    targetVolume.id,
  );
  if (!normalized) {
    throw new Error("功能验收表格式无效。");
  }
  if (normalized.volumeId !== targetVolume.id) {
    throw new Error("功能验收表 volumeId 与目标卷不一致。");
  }
  return functionAcceptanceStatusService.upsertTable(document, {
    ...normalized,
    volumeId: targetVolume.id,
  });
}

async function generateChapterDetail(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const targetVolume = getTargetVolume(document, options.targetVolumeId);
  const targetChapter = getTargetChapter(targetVolume, options.targetChapterId);
  const detailMode = options.detailMode;
  if (!detailMode) {
    throw new Error("生成章节细化时必须指定 detailMode。");
  }

  const promptInput = {
    novel,
    workspace,
    storyMacroPlan,
    strategyPlan: document.strategyPlan,
    targetVolume,
    targetBeatSheet: getBeatSheet(document, targetVolume.id),
    targetChapter,
    guidance: options.guidance,
    detailMode,
  };
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "chapter_detail",
    phase: "prompt",
    label: `正在细化第 ${targetVolume.sortOrder} 卷第 ${targetChapter.chapterOrder} 章 ${formatChapterDetailModeLabel(detailMode)}`,
    options,
  });
  const generated = detailMode === "purpose"
    ? await runStructuredPrompt({
      asset: volumeChapterPurposePrompt,
      promptInput,
      contextBlocks: buildVolumeChapterDetailContextBlocks(promptInput),
      options: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature ?? 0.35,
        taskId: options.taskId,
        entrypoint: options.entrypoint,
        novelId: document.novelId,
        volumeId: targetVolume.id,
        chapterId: targetChapter.id,
        stage: "chapter_detail_purpose",
        itemKey: "chapter_detail_bundle",
        scope: "chapter_detail",
        triggerReason: "chapter_detail_generation",
        signal: options.signal,
      },
    })
    : detailMode === "boundary"
      ? await runStructuredPrompt({
        asset: volumeChapterBoundaryPrompt,
        promptInput,
        contextBlocks: buildVolumeChapterDetailContextBlocks(promptInput),
        options: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature ?? 0.35,
          taskId: options.taskId,
          entrypoint: options.entrypoint,
          novelId: document.novelId,
          volumeId: targetVolume.id,
          chapterId: targetChapter.id,
          stage: "chapter_detail_boundary",
          itemKey: "chapter_detail_bundle",
          scope: "chapter_detail",
          triggerReason: "chapter_detail_generation",
          signal: options.signal,
        },
      })
      : {
        output: await generateChapterTaskSheetDetail({
          promptInput: {
            ...promptInput,
            detailMode: "task_sheet",
          },
          options,
        }),
      };

  return mergeChapterDetail({
    document,
    targetVolumeId: targetVolume.id,
    targetChapterId: targetChapter.id,
    detailMode,
    generatedDetail: generated.output as Record<string, unknown>,
  });
}

export async function generateVolumePlanDocument(params: {
  novelId: string;
  workspace: VolumeWorkspace;
  options?: VolumeGenerateOptions;
  storyMacroPlanService: Pick<StoryMacroPlanService, "getPlan">;
}): Promise<VolumePlanDocument> {
  const { novelId, workspace, options = {}, storyMacroPlanService } = params;
  const scope = normalizeScope(options.scope);
  const baseDocument = buildVolumeWorkspaceDocument({
    novelId,
    volumes: options.draftVolumes
      ? normalizeVolumeDraftContextInput(novelId, options.draftVolumes)
      : workspace.volumes,
    strategyPlan: workspace.strategyPlan,
    critiqueReport: workspace.critiqueReport,
    beatSheets: workspace.beatSheets,
    rebalanceDecisions: workspace.rebalanceDecisions,
    functionAcceptanceTables: workspace.functionAcceptanceTables,
    source: workspace.source,
    activeVersionId: workspace.activeVersionId,
  });
  assertScopeReadiness(baseDocument, scope, options.targetVolumeId);
  await notifyVolumeGenerationPhase({
    novelId,
    scope,
    phase: "load_context",
    label: scope === "chapter_list"
      ? "正在整理拆章上下文"
      : scope === "function_table"
        ? "正在整理功能验收表"
        : scope === "beat_sheet"
          ? "正在整理节奏板上下文"
          : scope === "skeleton"
            ? "正在整理卷骨架上下文"
            : scope === "strategy"
              ? "正在整理卷战略上下文"
              : scope === "rebalance"
                ? "正在整理相邻卷衔接上下文"
                : "正在整理卷规划上下文",
    options,
  });
  const { novel, storyMacroPlan } = await loadGenerationContext({
    novelId,
    workspace,
    storyMacroPlanService,
  });
  const currentWorkspace: VolumeWorkspace = {
    ...workspace,
    ...baseDocument,
  };

  if (scope === "strategy") {
    return generateStrategy({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "strategy_critique") {
    return generateStrategyCritique({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "skeleton") {
    return generateSkeleton({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "function_table") {
    return upsertFunctionTable({
      document: baseDocument,
      options,
    });
  }
  if (scope === "beat_sheet") {
    return generateBeatSheet({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
      notifyVolumeGenerationPhase,
    });
  }
  if (scope === "chapter_list") {
    return generateChapterList({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "rebalance") {
    return generateRebalance({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  return generateChapterDetail({
    document: baseDocument,
    novel,
    workspace: currentWorkspace,
    storyMacroPlan,
    options,
  });
}
