import { createHash } from "node:crypto";
import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type {
  ExtractedTimelineEvent,
  TimelineCheckResult,
  TimelineContextForChapter,
  TimelineHookDraft,
} from "@ai-novel/shared/types/timeline";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../../db/prisma";
import {
  storyTimelineService,
  timelineCheckerService,
  timelineContextService,
  timelineExtractorService,
  timelineRepository,
} from "../../../modules/timeline";
import { withBackgroundChapterLlmSlot } from "./backgroundLlmGate";
import {
  ChapterProjectionRevisionGuard,
  ChapterProjectionSupersededError,
} from "./projections";
import {
  ChapterTimelineCheckpointStore,
  type ChapterTimelineFinalizationMode,
} from "./timeline/ChapterTimelineCheckpointStore";

export type { ChapterTimelineFinalizationMode } from "./timeline/ChapterTimelineCheckpointStore";

export interface ChapterTimelineGateResult {
  result: TimelineCheckResult;
  extractedEvents: ExtractedTimelineEvent[];
  extractedHooks: TimelineHookDraft[];
  timeAnchor?: { storyDayIndex?: number | null; label?: string | null } | null;
  addressedHookIds: string[];
  resolvedHookIds: string[];
  extractorSucceeded: boolean;
  extractorError?: string | null;
  timelineContext: TimelineContextForChapter | null;
}

export interface ChapterTimelineFinalizationResult {
  syncMode: ChapterTimelineFinalizationMode;
  contentHash: string;
  extractorSucceeded: boolean;
  eventCount: number;
  hookCount: number;
  checkpointWritten: boolean;
}

interface TimelineFinalizationRequestOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

interface FinalizeCurrentContentInput {
  novelId: string;
  chapterId: string;
  expectedContentRevision: number;
  content: string;
  contextPackage?: GenerationContextPackage | null;
  request?: TimelineFinalizationRequestOptions;
  timelineGate?: ChapterTimelineGateResult | null;
  mode?: ChapterTimelineFinalizationMode;
  reason?: string;
  sourceStage: string;
  qualityDebt?: boolean;
}

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function chapterGoalFromContext(contextPackage: GenerationContextPackage | null | undefined): string {
  return uniqueStrings([
    contextPackage?.chapterMission?.objective,
    contextPackage?.chapter.expectation,
    contextPackage?.plan?.objective,
  ]).join("\n") || "推进当前章节任务";
}

function fallbackTimeLabel(input: {
  chapterIndex: number;
  contextPackage?: GenerationContextPackage | null;
  timelineContext?: TimelineContextForChapter | null;
}): string {
  return input.timelineContext?.currentTime?.label?.trim()
    || input.contextPackage?.timelineContext?.currentTime?.label?.trim()
    || `第 ${input.chapterIndex} 章`;
}

function openHookIds(context: TimelineContextForChapter | null | undefined): string[] {
  return context?.openHooks?.map((hook) => hook.id) ?? [];
}

function plannedEventIds(context: TimelineContextForChapter | null | undefined): string[] {
  return context?.plannedEventsThisChapter?.map((event) => event.id) ?? [];
}

function forbiddenEventIds(context: TimelineContextForChapter | null | undefined): string[] {
  return context?.forbiddenEvents?.map((event) => event.id) ?? [];
}

export class ChapterTimelineFinalizationService {
  private readonly checkpoints = new ChapterTimelineCheckpointStore();

  async hasCurrentFinalization(input: {
    novelId: string;
    chapterId: string;
    expectedContentRevision: number;
    content: string;
  }): Promise<boolean> {
    return Boolean(await this.findCurrentFinalizationMode(input));
  }

  private async findCurrentFinalizationMode(input: {
    novelId: string;
    chapterId: string;
    expectedContentRevision: number;
    content: string;
  }): Promise<ChapterTimelineFinalizationMode | null> {
    const contentHash = hashContent(input.content.trim());
    return this.checkpoints.findCurrentMode({ ...input, contentHash });
  }

  async ensurePreviousChapterFinalized(input: {
    novelId: string;
    currentChapterOrder: number;
    request?: TimelineFinalizationRequestOptions;
  }): Promise<ChapterTimelineFinalizationResult | null> {
    const previousChapter = await prisma.chapter.findFirst({
      where: {
        novelId: input.novelId,
        order: input.currentChapterOrder - 1,
        content: { not: null },
      },
      select: {
        id: true,
        title: true,
        order: true,
        content: true,
        contentRevision: true,
        expectation: true,
      },
    });
    const previousContent = previousChapter?.content?.trim();
    if (!previousChapter || !previousContent) {
      return null;
    }
    if (await this.hasCurrentFinalization({
      novelId: input.novelId,
      chapterId: previousChapter.id,
      expectedContentRevision: previousChapter.contentRevision,
      content: previousContent,
    })) {
      return null;
    }
    const novel = await prisma.novel.findUnique({
      where: { id: input.novelId },
      select: { title: true },
    });
    const timelineContext = await timelineContextService.buildForChapter({
      novelId: input.novelId,
      chapterId: previousChapter.id,
      chapterIndex: previousChapter.order,
    }).catch(() => null);
    const contextPackage = {
      chapter: {
        id: previousChapter.id,
        title: previousChapter.title,
        order: previousChapter.order,
        content: previousContent,
        expectation: previousChapter.expectation,
        supportingContextText: "",
      },
      timelineContext,
      bookContract: novel?.title ? { title: novel.title } : null,
    } as unknown as GenerationContextPackage;
    return this.finalizeCurrentContent({
      novelId: input.novelId,
      chapterId: previousChapter.id,
      expectedContentRevision: previousChapter.contentRevision,
      content: previousContent,
      contextPackage,
      request: input.request,
      sourceStage: "previous_chapter_guard",
      reason: "missing_current_timeline_finalization_checkpoint",
    });
  }

  async finalizeCurrentContent(input: FinalizeCurrentContentInput): Promise<ChapterTimelineFinalizationResult> {
    try {
      return await this.finalizeCurrentContentOwned(input);
    } catch (error) {
      if (!(error instanceof ChapterProjectionSupersededError)) {
        throw error;
      }
      const contentHash = hashContent(input.content.trim());
      const checkpointWritten = await this.checkpoints.markSuperseded({
        novelId: input.novelId,
        chapterId: input.chapterId,
        expectedContentRevision: input.expectedContentRevision,
        contentHash,
        sourceStage: input.sourceStage,
      });
      return {
        syncMode: "degraded",
        contentHash,
        extractorSucceeded: false,
        eventCount: 0,
        hookCount: 0,
        checkpointWritten,
      };
    }
  }

  private async finalizeCurrentContentOwned(input: FinalizeCurrentContentInput): Promise<ChapterTimelineFinalizationResult> {
    const content = input.content.trim();
    const contentHash = hashContent(content);
    await new ChapterProjectionRevisionGuard().assertCurrent({
      novelId: input.novelId,
      chapterId: input.chapterId,
      expectedContentRevision: input.expectedContentRevision,
    });
    const existingMode = await this.findCurrentFinalizationMode({
      novelId: input.novelId,
      chapterId: input.chapterId,
      expectedContentRevision: input.expectedContentRevision,
      content,
    });
    if (existingMode === "stable" || (existingMode === "degraded" && input.mode === "degraded")) {
      return {
        syncMode: existingMode,
        contentHash,
        extractorSucceeded: existingMode === "stable",
        eventCount: 0,
        hookCount: 0,
        checkpointWritten: true,
      };
    }
    if (!content) {
      return this.finalizeDegraded({
        ...input,
        content,
        contentHash,
        reason: input.reason ?? "empty_final_content",
        timelineContext: input.contextPackage?.timelineContext ?? null,
        extractorSucceeded: false,
        eventCount: 0,
        hookCount: 0,
        anchorFallbackUsed: true,
      });
    }

    const chapter = input.contextPackage?.chapter;
    const chapterIndex = chapter?.order ?? await this.resolveChapterOrder(input.chapterId);
    const timelineContext = input.timelineGate?.timelineContext
      ?? input.contextPackage?.timelineContext
      ?? await timelineContextService.buildForChapter({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterIndex,
      }).catch(() => null);

    if (input.mode === "degraded") {
      return this.finalizeDegraded({
        ...input,
        content,
        contentHash,
        timelineContext,
        extractorSucceeded: input.timelineGate?.extractorSucceeded ?? false,
        eventCount: input.timelineGate?.extractedEvents.length ?? 0,
        hookCount: input.timelineGate?.extractedHooks.length ?? 0,
        anchorFallbackUsed: true,
      });
    }

    const stableClaim = await this.checkpoints.claim({
      novelId: input.novelId,
      chapterId: input.chapterId,
      expectedContentRevision: input.expectedContentRevision,
      contentHash,
      syncMode: "stable",
      sourceStage: input.sourceStage,
      metadata: {
        reason: input.reason ?? "stable_timeline_finalization_started",
        sourceStage: input.sourceStage,
      },
    });
    if (stableClaim === "already_done") {
      return {
        syncMode: "stable",
        contentHash,
        extractorSucceeded: true,
        eventCount: 0,
        hookCount: 0,
        checkpointWritten: true,
      };
    }
    if (stableClaim === "running") {
      return {
        syncMode: "stable",
        contentHash,
        extractorSucceeded: false,
        eventCount: 0,
        hookCount: 0,
        checkpointWritten: false,
      };
    }

    const gate = input.timelineGate ?? await this.extractAndCheck({
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterIndex,
      chapterTitle: chapter?.title ?? `第 ${chapterIndex} 章`,
      novelTitle: input.contextPackage?.bookContract?.title ?? "当前小说",
      chapterGoal: chapterGoalFromContext(input.contextPackage),
      content,
      timelineContext,
      request: input.request,
    });

    if (!gate.timelineContext || !gate.extractorSucceeded || gate.result.status === "failed") {
      await this.checkpoints.markFailed({
        novelId: input.novelId,
        chapterId: input.chapterId,
        expectedContentRevision: input.expectedContentRevision,
        contentHash,
        syncMode: "stable",
        sourceStage: input.sourceStage,
        metadata: {
          reason: input.reason ?? gate.extractorError ?? `timeline_${gate.result.status}`,
          sourceStage: input.sourceStage,
          extractorSucceeded: gate.extractorSucceeded,
        },
      });
      return this.finalizeDegraded({
        ...input,
        content,
        contentHash,
        timelineContext: gate.timelineContext ?? timelineContext,
        extractorSucceeded: gate.extractorSucceeded,
        eventCount: gate.extractedEvents.length,
        hookCount: gate.extractedHooks.length,
        anchorFallbackUsed: !gate.timeAnchor,
        reason: input.reason ?? gate.extractorError ?? `timeline_${gate.result.status}`,
      });
    }

    try {
      await storyTimelineService.commitChapterTimeline({
        novelId: input.novelId,
        chapterId: input.chapterId,
        expectedContentRevision: input.expectedContentRevision,
        chapterIndex,
        timeAnchor: gate.timeAnchor ?? null,
        extractedEvents: gate.extractedEvents,
        extractedHooks: gate.extractedHooks,
        addressedHookIds: gate.addressedHookIds,
        resolvedHookIds: gate.resolvedHookIds,
        timelineContext: gate.timelineContext,
        checkResult: gate.result,
      });
    } catch (error) {
      if (error instanceof ChapterProjectionSupersededError) {
        throw error;
      }
      await this.checkpoints.markFailed({
        novelId: input.novelId,
        chapterId: input.chapterId,
        expectedContentRevision: input.expectedContentRevision,
        contentHash,
        syncMode: "stable",
        sourceStage: input.sourceStage,
        metadata: {
          reason: `stable_commit_failed: ${error instanceof Error ? error.message : String(error)}`,
          sourceStage: input.sourceStage,
          extractorSucceeded: gate.extractorSucceeded,
        },
      });
      return this.finalizeDegraded({
        ...input,
        content,
        contentHash,
        timelineContext: gate.timelineContext,
        extractorSucceeded: gate.extractorSucceeded,
        eventCount: gate.extractedEvents.length,
        hookCount: gate.extractedHooks.length,
        anchorFallbackUsed: !gate.timeAnchor,
        reason: `stable_commit_failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    await this.checkpoints.markSucceeded({
      novelId: input.novelId,
      chapterId: input.chapterId,
      expectedContentRevision: input.expectedContentRevision,
      contentHash,
      syncMode: "stable",
      sourceStage: input.sourceStage,
      metadata: {
        reason: input.reason ?? "stable_timeline_finalized",
        sourceStage: input.sourceStage,
        extractorSucceeded: true,
        eventCount: gate.extractedEvents.length,
        hookCount: gate.extractedHooks.length,
        anchorFallbackUsed: !gate.timeAnchor,
        qualityDebt: Boolean(input.qualityDebt),
      },
    });
    return {
      syncMode: "stable",
      contentHash,
      extractorSucceeded: true,
      eventCount: gate.extractedEvents.length,
      hookCount: gate.extractedHooks.length,
      checkpointWritten: true,
    };
  }

  private async extractAndCheck(input: {
    novelId: string;
    chapterId: string;
    chapterIndex: number;
    novelTitle: string;
    chapterTitle: string;
    chapterGoal: string;
    content: string;
    timelineContext: TimelineContextForChapter | null;
    request?: TimelineFinalizationRequestOptions;
  }): Promise<ChapterTimelineGateResult> {
    if (!input.timelineContext) {
      return {
        result: {
          status: "warning",
          score: 0.82,
          issues: [{
            type: "unclear_time_anchor",
            severity: "warning",
            message: "缺少时间线上下文，已降级提交最小 timeline checkpoint。",
            evidence: "timelineContext missing",
            suggestedFix: "重新组装章节上下文后补跑 timeline finalization。",
            relatedEventIds: [],
            relatedHookIds: [],
          }],
        },
        extractedEvents: [],
        extractedHooks: [],
        timeAnchor: null,
        addressedHookIds: [],
        resolvedHookIds: [],
        extractorSucceeded: false,
        extractorError: "timelineContext missing",
        timelineContext: null,
      };
    }
    // Narrowed after early return above; local const keeps TS happy across the async slot.
    const timelineContext = input.timelineContext;
    try {
      const extracted = await withBackgroundChapterLlmSlot("timeline_extract", () => (
        timelineExtractorService.extractFromChapter({
          novelId: input.novelId,
          chapterId: input.chapterId,
          chapterIndex: input.chapterIndex,
          novelTitle: input.novelTitle,
          chapterTitle: input.chapterTitle,
          chapterGoal: input.chapterGoal,
          chapterContent: input.content,
          timelineContext,
          provider: input.request?.provider,
          model: input.request?.model,
          temperature: input.request?.temperature,
        })
      ));
      const extractedEvents = timelineExtractorService.normalizeEvents(extracted);
      const extractedHooks = timelineExtractorService.normalizeHooks(extracted);
      const result = timelineCheckerService.checkChapter({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterIndex: input.chapterIndex,
        extractedEvents,
        timelineContext: input.timelineContext,
        chapterContent: input.content,
      });
      return {
        result,
        extractedEvents,
        extractedHooks,
        timeAnchor: extracted.timeAnchor ?? null,
        addressedHookIds: extracted.addressedHookIds ?? [],
        resolvedHookIds: extracted.resolvedHookIds ?? [],
        extractorSucceeded: true,
        extractorError: null,
        timelineContext: input.timelineContext,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: TimelineCheckResult = {
        status: "warning",
        score: 0.82,
        issues: [{
          type: "unclear_time_anchor",
          severity: "warning",
          message: "时间线抽取或检测未完成，已降级提交最小 timeline checkpoint。",
          evidence: message,
          suggestedFix: "重试时间线检测；若仍失败，人工检查章节承接和未来事件泄漏。",
          relatedEventIds: [],
          relatedHookIds: [],
        }],
      };
      return {
        result,
        extractedEvents: [],
        extractedHooks: [],
        timeAnchor: null,
        addressedHookIds: [],
        resolvedHookIds: [],
        extractorSucceeded: false,
        extractorError: message,
        timelineContext: input.timelineContext,
      };
    }
  }

  private async finalizeDegraded(input: FinalizeCurrentContentInput & {
    contentHash: string;
    timelineContext: TimelineContextForChapter | null;
    extractorSucceeded: boolean;
    eventCount: number;
    hookCount: number;
    anchorFallbackUsed: boolean;
  }): Promise<ChapterTimelineFinalizationResult> {
    const chapterIndex = input.contextPackage?.chapter.order ?? await this.resolveChapterOrder(input.chapterId);
    if (!timelineRepository.commitDegradedChapterTimeline) {
      throw new Error("Timeline repository does not support revision-owned degraded commits");
    }
    await timelineRepository.commitDegradedChapterTimeline({
      owner: {
        novelId: input.novelId,
        chapterId: input.chapterId,
        expectedContentRevision: input.expectedContentRevision,
      },
      anchor: {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterIndex,
        storyDayIndex: input.timelineContext?.currentTime?.storyDayIndex ?? null,
        timeLabel: fallbackTimeLabel({
          chapterIndex,
          contextPackage: input.contextPackage,
          timelineContext: input.timelineContext,
        }),
        startsAfterEventIds: input.timelineContext?.previousEvents?.slice(-3).map((event) => event.id) ?? [],
        plannedEventIds: plannedEventIds(input.timelineContext),
        endedWithEventIds: [],
        previousHookIds: openHookIds(input.timelineContext),
        nextHookIds: [],
        forbiddenEventIds: forbiddenEventIds(input.timelineContext),
      },
      expireOverdueImmediateHooks: Boolean(
        input.qualityDebt || input.sourceStage === "defer_and_continue",
      ),
    });
    await this.checkpoints.markSucceeded({
      novelId: input.novelId,
      chapterId: input.chapterId,
      expectedContentRevision: input.expectedContentRevision,
      contentHash: input.contentHash,
      syncMode: "degraded",
      sourceStage: input.sourceStage,
      metadata: {
        reason: input.reason ?? "degraded_timeline_finalized",
        sourceStage: input.sourceStage,
        extractorSucceeded: input.extractorSucceeded,
        eventCount: input.eventCount,
        hookCount: input.hookCount,
        anchorFallbackUsed: input.anchorFallbackUsed,
        qualityDebt: Boolean(input.qualityDebt),
      },
    });
    return {
      syncMode: "degraded",
      contentHash: input.contentHash,
      extractorSucceeded: input.extractorSucceeded,
      eventCount: input.eventCount,
      hookCount: input.hookCount,
      checkpointWritten: true,
    };
  }

  private async resolveChapterOrder(chapterId: string): Promise<number> {
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { order: true },
    });
    return chapter?.order ?? 0;
  }

}

export const chapterTimelineFinalizationService = new ChapterTimelineFinalizationService();
