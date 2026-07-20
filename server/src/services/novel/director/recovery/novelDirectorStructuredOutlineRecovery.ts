import type {
  VolumeBeat,
  VolumeChapterPlan,
  VolumePlan,
  VolumePlanDocument,
} from "@ai-novel/shared/types/novel";
import { assessChapterExecutionContractShape } from "@ai-novel/shared/types/chapterTaskSheetQuality";
import type { DirectorAutoExecutionPlan } from "@ai-novel/shared/types/novelDirector";
import {
  buildDirectorAutoExecutionScopeLabel,
  countDirectorAutoExecutionChapterRange,
  normalizeDirectorAutoExecutionPlan,
  resolveDirectorAutoExecutionPlanChapterRange,
} from "../automation/novelDirectorAutoExecution";
import { DIRECTOR_CHAPTER_DETAIL_MODES } from "../projections/novelDirectorProgress";
import {
  getBeatExpectedChapterCount,
  getBeatSheet,
  isVolumeChapterListPartiallyPersisted,
  resolveVolumeChapterBeatKey,
} from "../../volume/volumeGenerationHelpers";

export type StructuredOutlineDetailMode = (typeof DIRECTOR_CHAPTER_DETAIL_MODES)[number];
export type StructuredOutlineRecoveryStep =
  | "beat_sheet"
  | "chapter_list"
  | "chapter_detail_bundle"
  | "chapter_sync"
  | "completed";

export interface PreparedOutlineChapterRef {
  id: string;
  volumeId: string;
  volumeOrder: number;
  volumeTitle: string;
  chapterOrder: number;
  title: string;
}

export interface StructuredOutlineRecoveryCursor {
  step: StructuredOutlineRecoveryStep;
  scopeLabel: string;
  requiredVolumes: VolumePlan[];
  preparedVolumeIds: string[];
  selectedChapters: PreparedOutlineChapterRef[];
  totalChapterCount: number;
  completedChapterCount: number;
  totalDetailSteps: number;
  completedDetailSteps: number;
  nextChapterIndex: number | null;
  volumeId: string | null;
  volumeOrder: number | null;
  volumeTitle: string | null;
  beatKey: string | null;
  beatLabel: string | null;
  chapterId: string | null;
  chapterOrder: number | null;
  detailMode: StructuredOutlineDetailMode | null;
}

function hasPreparedOutlineChapterBoundary(chapter: VolumeChapterPlan | null): boolean {
  if (!chapter) {
    return false;
  }
  return typeof chapter.conflictLevel === "number"
    || typeof chapter.revealLevel === "number"
    || typeof chapter.targetWordCount === "number"
    || Boolean(chapter.mustAvoid?.trim())
    || chapter.payoffRefs.length > 0;
}

export function hasPreparedOutlineChapterExecutionDetail(
  chapter: VolumeChapterPlan | null,
  options?: {
    settingQualityMode?: "off" | "advisory" | "enforce" | null;
    qualityMode?: "full_book_autopilot" | "ai_copilot" | "manual" | null;
  },
): boolean {
  if (!chapter) {
    return false;
  }
  return assessChapterExecutionContractShape({
    novelId: "workspace",
    volumeId: chapter.volumeId,
    chapterId: chapter.id,
    chapterOrder: chapter.chapterOrder,
    title: chapter.title,
    summary: chapter.summary,
    purpose: chapter.purpose,
    exclusiveEvent: chapter.exclusiveEvent,
    endingState: chapter.endingState,
    nextChapterEntryState: chapter.nextChapterEntryState,
    conflictLevel: chapter.conflictLevel,
    revealLevel: chapter.revealLevel,
    targetWordCount: chapter.targetWordCount,
    mustAvoid: chapter.mustAvoid,
    payoffRefs: chapter.payoffRefs,
    taskSheet: chapter.taskSheet,
    sceneCards: chapter.sceneCards,
  }, {
    settingQualityMode: options?.settingQualityMode ?? undefined,
    qualityMode: options?.qualityMode ?? undefined,
  }).canEnterExecution;
}

function hasPreparedOutlineChapterDetailMode(
  chapter: VolumeChapterPlan | null,
  detailMode: StructuredOutlineDetailMode,
): boolean {
  if (!chapter) {
    return false;
  }
  if (detailMode === "task_sheet") {
    return hasPreparedOutlineChapterExecutionDetail(chapter);
  }
  return Boolean(chapter.taskSheet?.trim()) || Boolean(chapter.purpose?.trim()) || hasPreparedOutlineChapterBoundary(chapter);
}

function findPreparedOutlineChapterDetail(
  workspace: VolumePlanDocument,
  target: PreparedOutlineChapterRef,
): VolumePlanDocument["volumes"][number]["chapters"][number] | null {
  const volume = workspace.volumes.find((item) => item.id === target.volumeId);
  if (!volume) {
    return null;
  }
  return volume.chapters.find((chapter) => chapter.id === target.id) ?? null;
}

export function flattenPreparedOutlineChapters(workspace: VolumePlanDocument): PreparedOutlineChapterRef[] {
  return workspace.volumes
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .flatMap((volume) => volume.chapters
      .slice()
      .sort((left, right) => left.chapterOrder - right.chapterOrder)
      .map((chapter) => ({
        id: chapter.id,
        volumeId: volume.id,
        volumeOrder: volume.sortOrder,
        volumeTitle: volume.title,
        chapterOrder: chapter.chapterOrder,
        title: chapter.title,
      })));
}

function resolveRequiredVolumes(
  workspace: VolumePlanDocument,
  plan: DirectorAutoExecutionPlan | null | undefined,
): VolumePlan[] {
  const normalizedPlan = normalizeDirectorAutoExecutionPlan(plan);
  const sortedVolumes = workspace.volumes
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const requiredVolumes: VolumePlan[] = [];
  let maxPreparedChapterOrder = 0;
  const targetChapterRange = resolveDirectorAutoExecutionPlanChapterRange(normalizedPlan);

  for (const volume of sortedVolumes) {
    if (normalizedPlan.mode === "volume" && volume.sortOrder > (normalizedPlan.volumeOrder ?? 1)) {
      break;
    }
    if (targetChapterRange && maxPreparedChapterOrder >= targetChapterRange.endOrder) {
      break;
    }

    requiredVolumes.push(volume);
    maxPreparedChapterOrder = Math.max(
      maxPreparedChapterOrder,
      ...volume.chapters.map((chapter) => chapter.chapterOrder),
    );
  }

  return requiredVolumes;
}

/**
 * 找出「已拆章卷之后、章数为 0」的后卫卷 id —— 这些卷被视为尚未规划、不在当前批范围的
 * 后续卷。mode:"book" 时跳过它们的节奏板推断，防止与 continue 复用 seed plan 叠加形成
 * 死锁。没有已拆章卷(book 全空)时返回空，保持「全空书应当先建首卷节奏板」的原有行为。
 */
function resolveTrailingZeroChapterVolumeIds(volumes: VolumePlan[]): string[] {
  if (volumes.length === 0) {
    return [];
  }
  const stagedSortOrders = volumes
    .filter((volume) => volume.chapters.length > 0)
    .map((volume) => volume.sortOrder);
  if (stagedSortOrders.length === 0) {
    return [];
  }
  const lastStagedSortOrder = Math.max(...stagedSortOrders);
  return volumes
    .filter((volume) => volume.chapters.length === 0 && volume.sortOrder > lastStagedSortOrder)
    .map((volume) => volume.id);
}

function selectPreparedOutlineChapters(
  workspace: VolumePlanDocument,
  plan: DirectorAutoExecutionPlan | null | undefined,
): PreparedOutlineChapterRef[] {
  const normalizedPlan = normalizeDirectorAutoExecutionPlan(plan);
  const prepared = flattenPreparedOutlineChapters(workspace);
  if (normalizedPlan.mode === "book") {
    return prepared;
  }
  if (normalizedPlan.mode === "volume") {
    return prepared.filter((chapter) => chapter.volumeOrder === normalizedPlan.volumeOrder);
  }
  const targetChapterRange = resolveDirectorAutoExecutionPlanChapterRange(normalizedPlan);
  if (targetChapterRange) {
    return prepared.filter((chapter) => (
      chapter.chapterOrder >= targetChapterRange.startOrder
      && chapter.chapterOrder <= targetChapterRange.endOrder
    ));
  }
  return [];
}

function resolveVolumeChapterListCursor(input: {
  volume: VolumePlan;
  workspace: VolumePlanDocument;
}): {
  isReady: boolean;
  nextBeat: VolumeBeat | null;
} {
  const beatSheet = getBeatSheet(input.workspace, input.volume.id);
  if (!beatSheet || beatSheet.beats.length === 0) {
    return {
      isReady: false,
      nextBeat: null,
    };
  }
  if (isVolumeChapterListPartiallyPersisted(input.volume)) {
    return {
      isReady: false,
      nextBeat: beatSheet.beats[0] ?? null,
    };
  }

  const chapters = input.volume.chapters
    .slice()
    .sort((left, right) => left.chapterOrder - right.chapterOrder);

  for (const beat of beatSheet.beats) {
    const matchedChapterCount = chapters.filter((chapter) => resolveVolumeChapterBeatKey({
      chapter,
      volume: input.volume,
      beatSheet,
    }) === beat.key).length;
    if (matchedChapterCount !== Math.max(1, getBeatExpectedChapterCount(beat))) {
      return {
        isReady: false,
        nextBeat: beat,
      };
    }
  }

  return {
    isReady: true,
    nextBeat: null,
  };
}

export function resolveStructuredOutlineRecoveryCursor(input: {
  workspace: VolumePlanDocument;
  plan?: DirectorAutoExecutionPlan | null;
}): StructuredOutlineRecoveryCursor {
  const normalizedPlan = normalizeDirectorAutoExecutionPlan(input.plan);
  const requiredVolumes = resolveRequiredVolumes(input.workspace, normalizedPlan);
  const preparedVolumeIds: string[] = [];

  // mode:"book" 时若整书已存在「已拆章的卷」，则其后卫卷(0 章 + 无节奏板)视为「尚未规划、
  // 不在本轮范围内」跳过 —— 否则把未拆章的后续卷当成必须先补节奏板的阻塞门，会与 continue
  // 复用 seed plan 叠加形成无限失败循环(死锁)：validateOutput 永远判 beat_sheet 未完成 →
  // 任务 failed → continue 用同 seed 的 mode:"book" 重入 → 同一阻塞门。卷一旦拆了章，
  // 节奏板缺失才视为真正需要补。mode:"volume"/"chapter_range" 不变(各自有显式范围)。
  const trailingUnstagedVolumeIds = normalizedPlan.mode === "book"
    ? new Set(resolveTrailingZeroChapterVolumeIds(requiredVolumes))
    : new Set<string>();

  for (const volume of requiredVolumes) {
    const beatSheet = getBeatSheet(input.workspace, volume.id);
    if (
      trailingUnstagedVolumeIds.has(volume.id)
      && (!beatSheet || beatSheet.beats.length === 0)
    ) {
      continue;
    }
    if (!beatSheet || beatSheet.beats.length === 0) {
      return {
        step: "beat_sheet",
        scopeLabel: buildDirectorAutoExecutionScopeLabel(normalizedPlan, null, volume.title),
        requiredVolumes,
        preparedVolumeIds,
        selectedChapters: [],
        totalChapterCount: 0,
        completedChapterCount: 0,
        totalDetailSteps: 0,
        completedDetailSteps: 0,
        nextChapterIndex: null,
        volumeId: volume.id,
        volumeOrder: volume.sortOrder,
        volumeTitle: volume.title,
        beatKey: null,
        beatLabel: null,
        chapterId: null,
        chapterOrder: null,
        detailMode: null,
      };
    }

    const chapterListCursor = resolveVolumeChapterListCursor({
      volume,
      workspace: input.workspace,
    });
    if (!chapterListCursor.isReady) {
      return {
        step: "chapter_list",
        scopeLabel: buildDirectorAutoExecutionScopeLabel(normalizedPlan, null, volume.title),
        requiredVolumes,
        preparedVolumeIds,
        selectedChapters: [],
        totalChapterCount: 0,
        completedChapterCount: 0,
        totalDetailSteps: 0,
        completedDetailSteps: 0,
        nextChapterIndex: null,
        volumeId: volume.id,
        volumeOrder: volume.sortOrder,
        volumeTitle: volume.title,
        beatKey: chapterListCursor.nextBeat?.key ?? null,
        beatLabel: chapterListCursor.nextBeat?.label ?? null,
        chapterId: null,
        chapterOrder: null,
        detailMode: null,
      };
    }

    preparedVolumeIds.push(volume.id);
  }

  const selectedChapters = selectPreparedOutlineChapters(input.workspace, normalizedPlan);
  const totalDetailSteps = selectedChapters.length * DIRECTOR_CHAPTER_DETAIL_MODES.length;
  let completedDetailSteps = 0;
  let completedChapterCount = 0;
  let nextChapterIndex: number | null = null;
  let nextChapter: PreparedOutlineChapterRef | null = null;
  let nextDetailMode: StructuredOutlineDetailMode | null = null;

  for (const [chapterIndex, chapterRef] of selectedChapters.entries()) {
    const chapter = findPreparedOutlineChapterDetail(input.workspace, chapterRef);
    let chapterComplete = true;
    for (const detailMode of DIRECTOR_CHAPTER_DETAIL_MODES) {
      if (hasPreparedOutlineChapterDetailMode(chapter, detailMode)) {
        completedDetailSteps += 1;
        continue;
      }
      chapterComplete = false;
      if (nextChapterIndex == null) {
        nextChapterIndex = chapterIndex;
        nextChapter = chapterRef;
        nextDetailMode = detailMode;
      }
      break;
    }
    if (chapterComplete) {
      completedChapterCount += 1;
    }
  }

  const selectedChapterRange = resolveDirectorAutoExecutionPlanChapterRange(normalizedPlan);
  const scopeLabel = buildDirectorAutoExecutionScopeLabel(
    normalizedPlan,
    selectedChapterRange ? countDirectorAutoExecutionChapterRange(selectedChapterRange) : selectedChapters.length,
    normalizedPlan.mode === "volume" ? selectedChapters[0]?.volumeTitle ?? null : null,
  );

  if (nextChapter && nextDetailMode) {
    return {
      step: "chapter_detail_bundle",
      scopeLabel,
      requiredVolumes,
      preparedVolumeIds,
      selectedChapters,
      totalChapterCount: selectedChapters.length,
      completedChapterCount,
      totalDetailSteps,
      completedDetailSteps,
      nextChapterIndex,
      volumeId: nextChapter.volumeId,
      volumeOrder: nextChapter.volumeOrder,
      volumeTitle: nextChapter.volumeTitle,
      beatKey: null,
      beatLabel: null,
      chapterId: nextChapter.id,
      chapterOrder: nextChapter.chapterOrder,
      detailMode: nextDetailMode,
    };
  }

  return {
    step: selectedChapters.length > 0 ? "chapter_sync" : "completed",
    scopeLabel,
    requiredVolumes,
    preparedVolumeIds,
    selectedChapters,
    totalChapterCount: selectedChapters.length,
    completedChapterCount,
    totalDetailSteps,
    completedDetailSteps,
    nextChapterIndex: null,
    volumeId: null,
    volumeOrder: null,
    volumeTitle: null,
    beatKey: null,
    beatLabel: null,
    chapterId: null,
    chapterOrder: null,
    detailMode: null,
  };
}
