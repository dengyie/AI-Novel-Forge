import type {
  ChapterTimeAnchor,
  ExtractedTimelineEvent,
  TimelineHookDraft,
  TimelineCheckResult,
  TimelineContextForChapter,
} from "@ai-novel/shared/types/timeline";
import { timelineRepository, type TimelineRepository } from "./timeline.repository";

function eventKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function normalizeHookText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hookPriorityRank(priority: TimelineHookDraft["priority"]): number {
  if (priority === "critical") {
    return 0;
  }
  if (priority === "high") {
    return 1;
  }
  if (priority === "medium") {
    return 2;
  }
  return 3;
}

function hookResolveModeRank(resolveMode: TimelineHookDraft["resolveMode"]): number {
  if (resolveMode === "immediate") {
    return 0;
  }
  if (resolveMode === "short_arc") {
    return 1;
  }
  return 2;
}

function mergeHookDrafts(
  hooks: Array<TimelineHookDraft & { relatedEventIndexes: number[] }>,
): Array<TimelineHookDraft & { relatedEventIndexes: number[] }> {
  const merged = new Map<string, TimelineHookDraft & { relatedEventIndexes: number[] }>();
  for (const hook of hooks) {
    const draft: TimelineHookDraft & { relatedEventIndexes: number[] } = {
      title: normalizeHookText(hook.title),
      description: normalizeHookText(hook.description),
      priority: hook.priority,
      resolveMode: hook.resolveMode ?? "long_arc",
      blocking: hook.blocking ?? false,
      relatedEventIndexes: Array.from(new Set(hook.relatedEventIndexes ?? [])),
    };
    const key = `${draft.title}::${draft.description}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, draft);
      continue;
    }
    existing.relatedEventIndexes = Array.from(new Set([
      ...existing.relatedEventIndexes,
      ...draft.relatedEventIndexes,
    ]));
    if (draft.blocking) {
      existing.blocking = true;
    }
    if (hookResolveModeRank(draft.resolveMode) < hookResolveModeRank(existing.resolveMode)) {
      existing.resolveMode = draft.resolveMode;
    }
    if (hookPriorityRank(draft.priority) < hookPriorityRank(existing.priority)) {
      existing.priority = draft.priority;
    }
  }
  return Array.from(merged.values());
}

function uniqueHookIds(ids: string[], context: TimelineContextForChapter): string[] {
  const knownHookIds = new Set([
    ...(context.openHooks ?? []).map((hook) => hook.id),
    ...(context.blockingHooks ?? []).map((hook) => hook.id),
    ...(context.softHooks ?? []).map((hook) => hook.id),
    ...(context.addressedHooks ?? []).map((hook) => hook.id),
  ]);
  return Array.from(new Set(ids.filter((id) => knownHookIds.has(id))));
}

function fallbackAddressedHookIds(input: {
  extractedEvents: ExtractedTimelineEvent[];
  timelineContext: TimelineContextForChapter;
}): string[] {
  return input.timelineContext.openHooks
    .filter((hook) => hook.status === "open")
    .filter((hook) => input.extractedEvents.some((event) =>
      `${event.title}\n${event.summary}`.includes(hook.title) || hook.description.includes(event.title)))
    .map((hook) => hook.id);
}

function resolvePlannedEventIds(context: TimelineContextForChapter): string[] {
  return context.plannedEventsThisChapter?.map((event) => event.id) ?? [];
}

function resolveForbiddenEventIds(context: TimelineContextForChapter): string[] {
  return context.forbiddenEvents?.map((event) => event.id) ?? [];
}

function resolvePreviousEventIds(context: TimelineContextForChapter): string[] {
  return context.previousEvents?.slice(-3).map((event) => event.id) ?? [];
}

export class StoryTimelineService {
  constructor(private readonly repo: TimelineRepository = timelineRepository) {}

  async saveCheckReport(input: {
    novelId: string;
    chapterId: string;
    chapterIndex: number;
    result: TimelineCheckResult;
  }) {
    return this.repo.saveCheckReport({
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterIndex: input.chapterIndex,
      status: input.result.status,
      score: input.result.score,
      issues: input.result.issues,
    });
  }

  async commitChapterTimeline(input: {
    novelId: string;
    chapterId: string;
    expectedContentRevision: number;
    chapterIndex: number;
    timeAnchor?: { storyDayIndex?: number | null; label?: string | null } | null;
    extractedEvents: ExtractedTimelineEvent[];
    extractedHooks?: TimelineHookDraft[];
    addressedHookIds?: string[];
    resolvedHookIds?: string[];
    timelineContext: TimelineContextForChapter;
    checkResult: TimelineCheckResult;
  }) {
    const occurredEventsInput = input.extractedEvents.filter((event) => event.occurred);
    const occurredEvents = occurredEventsInput.map((event, index) => ({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterIndex: input.chapterIndex,
        eventOrder: input.chapterIndex * 1000 + index + 1,
        storyDayIndex: input.timelineContext.currentTime?.storyDayIndex ?? null,
        storyTimeLabel: input.timelineContext.currentTime?.label ?? null,
        title: event.title,
        summary: event.summary,
        type: event.type,
        status: "occurred" as const,
        visibility: "reader_known" as const,
        source: "chapter_extraction" as const,
        participantIds: [],
        locationId: null,
        factionIds: [],
        prerequisiteEventIds: [],
        consequenceEventIds: [],
        stateChanges: event.stateChanges,
        eventKey: eventKey(event.title),
        confidence: event.confidence,
      }));
    const anchor = {
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterIndex: input.chapterIndex,
      storyDayIndex: input.timeAnchor?.storyDayIndex ?? input.timelineContext.currentTime?.storyDayIndex ?? null,
      timeLabel: input.timeAnchor?.label?.trim()
        || input.timelineContext.currentTime?.label?.trim()
        || `第 ${input.chapterIndex} 章`,
      startsAfterEventIds: resolvePreviousEventIds(input.timelineContext),
      plannedEventIds: resolvePlannedEventIds(input.timelineContext),
      previousHookIds: uniqueHookIds((input.timelineContext.openHooks ?? []).map((hook) => hook.id), input.timelineContext),
      nextHookIds: [],
      forbiddenEventIds: resolveForbiddenEventIds(input.timelineContext),
    } satisfies Omit<ChapterTimeAnchor, "id" | "createdAt" | "updatedAt" | "endedWithEventIds">;
    let occurredCursor = 0;
    const hookDrafts = mergeHookDrafts([
      ...input.extractedEvents.flatMap((event) => {
        const relatedEventIndexes = event.occurred ? [occurredCursor++] : [];
        return event.possibleHooks.map((hook) => ({
          ...hook,
          relatedEventIndexes,
        }));
      }),
      ...(input.extractedHooks ?? []).map((hook) => ({
        ...hook,
        relatedEventIndexes: [],
      })),
    ]);
    const resolvedHookIds = uniqueHookIds(input.resolvedHookIds ?? [], input.timelineContext);
    const addressedHookIds = uniqueHookIds(input.addressedHookIds ?? [], input.timelineContext)
      .filter((id) => !resolvedHookIds.includes(id));
    const hookIdsToAddress = addressedHookIds.length > 0 || resolvedHookIds.length > 0
      ? addressedHookIds
      : fallbackAddressedHookIds({
          extractedEvents: input.extractedEvents,
          timelineContext: input.timelineContext,
        });
    if (!this.repo.commitAutomaticChapterTimeline) {
      throw new Error("Timeline repository does not support revision-owned commits");
    }
    return this.repo.commitAutomaticChapterTimeline({
      owner: {
        novelId: input.novelId,
        chapterId: input.chapterId,
        expectedContentRevision: input.expectedContentRevision,
      },
      events: occurredEvents,
      anchor,
      hooks: hookDrafts.map((hook) => ({
      novelId: input.novelId,
      createdInChapterId: input.chapterId,
      createdInChapterIndex: input.chapterIndex,
      expectedResolveByChapterIndex: hook.resolveMode === "immediate"
        ? input.chapterIndex + 1
        : hook.resolveMode === "short_arc"
          ? input.chapterIndex + 2
          : null,
      title: hook.title,
      description: hook.description,
      priority: hook.priority,
      resolveMode: hook.resolveMode,
      blocking: hook.blocking,
      relatedEventIndexes: hook.relatedEventIndexes,
      participantIds: [],
      })),
      addressedHookIds: hookIdsToAddress,
      resolvedHookIds,
      checkReport: {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterIndex: input.chapterIndex,
        status: input.checkResult.status,
        score: input.checkResult.score,
        issues: input.checkResult.issues,
      },
    });
  }
}

export const storyTimelineService = new StoryTimelineService();
