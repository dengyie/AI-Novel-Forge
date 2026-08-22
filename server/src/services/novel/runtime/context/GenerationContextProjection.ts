import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import { GENRE_BEAT_SCENE_DIVERSITY_WINDOW } from "@ai-novel/shared/types/genreBeatQuota";
import { plannerService } from "../../../planner/PlannerService";
import { parseJsonStringArray } from "../../novelP0Utils";
import { parseJsonStringArraySafe } from "../runtimeContextBlocks";

export const OPENING_COMPARE_LIMIT = 3;
export const SCENE_DIVERSITY_LOOKBACK = GENRE_BEAT_SCENE_DIVERSITY_WINDOW;

export const runtimeChapterSelect = {
  id: true,
  title: true,
  order: true,
  content: true,
  contentRevision: true,
  expectation: true,
  targetWordCount: true,
  conflictLevel: true,
  revealLevel: true,
  mustAvoid: true,
  taskSheet: true,
  sceneCards: true,
  hook: true,
  riskFlags: true,
} as const;

export function extractOpening(content: string, maxLength = 220): string {
  return content.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function extractChapterTail(content: string | null | undefined, maxLength = 520): string {
  const normalized = (content ?? "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(Math.max(0, normalized.length - maxLength)) : "";
}

function normalizeRuntimeName(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function mapRuntimeChapterPlan(
  plan: Awaited<ReturnType<typeof plannerService.getChapterPlan>>,
): GenerationContextPackage["plan"] {
  if (!plan) return null;
  return {
    id: plan.id,
    chapterId: plan.chapterId ?? null,
    planRole: plan.planRole ?? null,
    phaseLabel: plan.phaseLabel ?? null,
    title: plan.title,
    objective: plan.objective,
    participants: parseJsonStringArray(plan.participantsJson),
    reveals: parseJsonStringArray(plan.revealsJson),
    riskNotes: parseJsonStringArray(plan.riskNotesJson),
    mustAdvance: parseJsonStringArray(plan.mustAdvanceJson),
    mustPreserve: parseJsonStringArray(plan.mustPreserveJson),
    sourceIssueIds: parseJsonStringArray(plan.sourceIssueIdsJson),
    replannedFromPlanId: plan.replannedFromPlanId ?? null,
    hookTarget: plan.hookTarget ?? null,
    rawPlanJson: plan.rawPlanJson ?? null,
    scenes: plan.scenes.map((scene: (typeof plan.scenes)[number]) => ({
      id: scene.id,
      sortOrder: scene.sortOrder,
      title: scene.title,
      objective: scene.objective ?? null,
      conflict: scene.conflict ?? null,
      reveal: scene.reveal ?? null,
      emotionBeat: scene.emotionBeat ?? null,
    })),
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

export function resolveChapterResourceCharacterIds(input: {
  plan: Awaited<ReturnType<typeof plannerService.getChapterPlan>>;
  characters: Array<{ id: string; name: string }>;
}): string[] {
  const participantNames = new Set(
    parseJsonStringArray(input.plan?.participantsJson ?? null).map(normalizeRuntimeName).filter(Boolean),
  );
  if (participantNames.size === 0) return [];
  return input.characters
    .filter((character) => participantNames.has(normalizeRuntimeName(character.name)))
    .map((character) => character.id)
    .filter(Boolean);
}

export function findVolumeWindowSeed(
  volumeRows: Array<{
    id: string;
    sortOrder: number;
    title: string;
    summary: string | null;
    mainPromise: string | null;
    openPayoffsJson: string | null;
    chapters: Array<{ chapterOrder: number }>;
  }>,
  chapterOrder: number,
) {
  const currentIndex = volumeRows.findIndex((volume) => (
    volume.chapters.some((chapter) => chapter.chapterOrder === chapterOrder)
  ));
  if (currentIndex < 0) {
    return { currentVolume: null, previousVolume: null, nextVolume: null, softFutureSummary: "" };
  }
  const currentVolume = volumeRows[currentIndex];
  const previousVolume = currentIndex > 0 ? volumeRows[currentIndex - 1] : null;
  const nextVolume = currentIndex < volumeRows.length - 1 ? volumeRows[currentIndex + 1] : null;
  const futureVolumes = volumeRows.slice(currentIndex + 1, currentIndex + 4);
  return {
    currentVolume: {
      id: currentVolume.id,
      sortOrder: currentVolume.sortOrder,
      title: currentVolume.title,
      summary: currentVolume.summary,
      mainPromise: currentVolume.mainPromise,
      openPayoffs: parseJsonStringArraySafe(currentVolume.openPayoffsJson),
    },
    previousVolume: previousVolume ? { title: previousVolume.title, summary: previousVolume.summary } : null,
    nextVolume: nextVolume ? { title: nextVolume.title, summary: nextVolume.summary } : null,
    softFutureSummary: futureVolumes.length > 0
      ? futureVolumes
        .map((volume) => `Volume ${volume.sortOrder} ${volume.title}: ${volume.mainPromise ?? volume.summary ?? "pending"}`)
        .join("\n")
      : "",
  };
}
