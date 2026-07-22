import type { BaseMessageChunk } from "@langchain/core/messages";
import type { StreamDoneHelpers, StreamDonePayload, WritableSSEFrame } from "../../../llm/streaming";
import type { ChapterRuntimePackage, GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import { prisma } from "../../../db/prisma";
import { ChapterWritingGraph } from "../chapterWritingGraph";
import { toText } from "../novelP0Utils";
import { GenerationContextAssembler } from "./GenerationContextAssembler";
import { ChapterRuntimeReadinessService } from "./ChapterRuntimeReadinessService";
import type { ChapterRuntimeCallOptions, ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import type { AssembledRuntimeChapter } from "./chapterRuntimePipeline";
import {
  assertChapterContentNotEmpty,
  isChapterEmptyContentError,
  type ChapterEmptyContentError,
} from "./chapterEmptyContentError";
import {
  isChapterChineseProseGateError,
  type ChapterChineseProseGateError,
} from "./chapterChineseProseGateError";
import { throwIfChapterGenerationAborted } from "./chapterAbortGuard";
import {
  ChapterContentFinalizationService,
  type FinalizeChapterContentResult,
} from "./ChapterContentFinalizationService";
import { persistChapterQualityScores } from "../quality/chapterQualityScorePersist";
import { buildChapterRunStatusFrame } from "./chapterRunStatusFrame";

export interface ChapterStreamGenerationAgentRuntime {
  createChapterGenRun: (novelId: string, chapterId: string, chapterOrder: number) => Promise<string>;
}

export interface ChapterStreamGenerationOrchestratorDeps {
  assembler: Pick<GenerationContextAssembler, "assemble">;
  chapterWritingGraph: Pick<ChapterWritingGraph, "createChapterStream">;
  readinessService: Pick<ChapterRuntimeReadinessService, "assertReady">;
  contentFinalizationService: Pick<ChapterContentFinalizationService, "finalizeChapterContent" | "markChapterStatus">;
  agentRuntime: ChapterStreamGenerationAgentRuntime;
  validateRequest: (input: ChapterRuntimeRequestInput) => ChapterRuntimeRequestInput;
  ensureNovelCharacters: (novelId: string, actionName: string, minCount?: number) => Promise<void>;
  /** 下章入口：补齐上章 timeline checkpoint（失败只告警，不阻断组装） */
  ensurePreviousChapterTimeline?: (input: {
    novelId: string;
    currentChapterOrder: number;
    request: ChapterRuntimeRequestInput;
  }) => Promise<unknown>;
}

export interface PreparedRuntimeChapter {
  request: ChapterRuntimeRequestInput;
  assembled: AssembledRuntimeChapter;
}

export class ChapterStreamGenerationOrchestrator {
  private readonly deps: ChapterStreamGenerationOrchestratorDeps;

  constructor(deps: ChapterStreamGenerationOrchestratorDeps) {
    this.deps = deps;
  }

  async createChapterStream(
    novelId: string,
    chapterId: string,
    options: ChapterRuntimeCallOptions = {},
    config: { includeRuntimePackage: boolean } = { includeRuntimePackage: false },
  ): Promise<{
    stream: AsyncIterable<BaseMessageChunk>;
    onDone: (fullContent: string, helpers: StreamDoneHelpers) => Promise<void | StreamDonePayload>;
  }> {
    const cancelSignal = options.signal;
    const { request, assembled } = await this.prepareRuntimeChapter(novelId, chapterId, options);
    await this.markChapterStatus(chapterId, "generating");

    let traceRunId: string | null = null;
    try {
      traceRunId = await this.deps.agentRuntime.createChapterGenRun(novelId, chapterId, assembled.chapter.order);
    } catch {
      traceRunId = null;
    }

    const startMs = Date.now();
    const writerResult = await this.deps.chapterWritingGraph.createChapterStream({
      novelId,
      novelTitle: assembled.novel.title,
      chapter: assembled.chapter,
      contextPackage: assembled.contextPackage,
      options: {
        ...request,
        signal: cancelSignal,
      },
    });

    return {
      stream: writerResult.stream,
      onDone: async (fullContent: string, helpers: StreamDoneHelpers) => {
        throwIfChapterGenerationAborted(cancelSignal);
        const runStatusId = traceRunId ?? `chapter-runtime:${chapterId}`;
        this.emitRunStatus(helpers, buildChapterRunStatusFrame({
          runId: runStatusId,
          status: "running",
          phase: "finalizing",
          message: "正文已生成，正在整理章节文本并保存草稿。",
        }));
        const normalized = await this.resolveWriterResultWithEmptyRetry({
          novelId,
          chapterId,
          request,
          assembled,
          writerDone: () => writerResult.onDone(fullContent),
          fallbackContent: fullContent,
          signal: cancelSignal,
        });
        const generatedContent = normalized.finalContent;
        this.emitRunStatus(helpers, buildChapterRunStatusFrame({
          runId: runStatusId,
          status: "running",
          phase: "finalizing",
          message: "正在完成正文接收检查并同步章节状态。",
        }));
        const finalized = await this.finalizeChapterContent({
          novelId,
          chapterId,
          request,
          contextPackage: assembled.contextPackage,
          content: generatedContent,
          lengthControl: normalized?.lengthControl,
          runId: traceRunId,
          startMs,
          deferArtifactBackgroundSync: true,
        });
        // 流式定稿不经 pipeline：finalize 只拍平列，此处写终态 QualityReport 一行。
        // 直接调 persist（writeReport:true），避免经 novelCoreReviewService 造成循环依赖。
        try {
          await persistChapterQualityScores({
            novelId,
            chapterId,
            score: finalized.score,
            issues: finalized.issues,
            writeReport: true,
          });
        } catch (error) {
          console.warn("[chapter-runtime] stream quality report persist failed", {
            novelId,
            chapterId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.emitRunStatus(helpers, buildChapterRunStatusFrame({
          runId: runStatusId,
          // P1-1：对齐 F9 repair 流契约（ChapterRepairStreamRuntime:569）——audit 检出
          // blocking issue 时章节将落 needs_repair，run_status 必发 failed（与文案"待修复"一致）。
          // 取证：监管 poller（ChapterExecutionProgressInspector）从 DB chapter row + audit flags
          // 重推 needs_repair，不读此 SSE status 字段，故非 poller 漏网风险；此处仅统一跨运行时
          // run_status 契约 + 客户端 UI 文案，防返回 succeeded-only 误导手工审校把待修章当已过审。
          status: finalized.runtimePackage.audit.hasBlockingIssues ? "failed" : "succeeded",
          phase: "completed",
          message: finalized.runtimePackage.audit.hasBlockingIssues
            ? "章节已保存，但检测到待修复问题。"
            : "章节已保存，可继续审校。",
        }));

        return {
          fullContent: finalized.finalContent,
          frames: config.includeRuntimePackage
            ? [{ type: "runtime_package", package: finalized.runtimePackage }]
            : [],
        };
      },
    };
  }

  async prepareRuntimeChapter(
    novelId: string,
    chapterId: string,
    options: ChapterRuntimeCallOptions = {},
  ): Promise<PreparedRuntimeChapter> {
    // signal 不可序列化，不进 zod；从 call options 剥离后再 validate 请求体字段
    const { signal: _signal, ...requestInput } = options;
    const request = this.deps.validateRequest(requestInput);
    await this.deps.ensureNovelCharacters(novelId, "generate chapter content");
    const assembled = await this.deps.assembler.assemble(novelId, chapterId, request);
    // 下章入口硬守卫：上章尚无 timeline checkpoint 时先补齐（stable/degraded），失败只告警。
    // 与定稿后 async schedule 互补，覆盖「异步未完成就开下一章」的长跑缺口。
    if (this.deps.ensurePreviousChapterTimeline && assembled.chapter.order > 1) {
      await this.deps.ensurePreviousChapterTimeline({
        novelId,
        currentChapterOrder: assembled.chapter.order,
        request,
      }).catch((error) => {
        console.warn("[chapter-runtime] previous chapter timeline guard failed before write", {
          novelId,
          chapterId,
          chapterOrder: assembled.chapter.order,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.deps.readinessService.assertReady(assembled.contextPackage);
    this.assertStateDrivenReady(assembled.contextPackage, request);
    return {
      request,
      assembled: assembled as AssembledRuntimeChapter,
    };
  }

  async generateDraftFromWriter(input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    assembled: AssembledRuntimeChapter;
    signal?: AbortSignal;
  }): Promise<{
    content: string;
    lengthControl?: ChapterRuntimePackage["lengthControl"];
    artifactsAlreadySynced?: boolean;
    backgroundSyncDeferred?: boolean;
  }> {
    throwIfChapterGenerationAborted(input.signal, "章节生成已取消。");
    const writerResult = await this.deps.chapterWritingGraph.createChapterStream({
      novelId: input.novelId,
      novelTitle: input.assembled.novel.title,
      chapter: input.assembled.chapter,
      contextPackage: input.assembled.contextPackage,
      options: {
        ...input.request,
        deferArtifactBackgroundSync: true,
        signal: input.signal,
      },
    });

    let fullContent = "";
    for await (const chunk of writerResult.stream) {
      throwIfChapterGenerationAborted(input.signal, "章节生成已取消。");
      fullContent += toText(chunk.content);
    }
    const normalized = await writerResult.onDone(fullContent);
    const content = assertChapterContentNotEmpty(normalized?.finalContent ?? fullContent, {
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterOrder: input.assembled.chapter.order,
      source: "chapter_runtime_writer",
    });
    return {
      content,
      lengthControl: normalized?.lengthControl,
      artifactsAlreadySynced: Boolean(normalized?.artifactsAlreadySynced),
      backgroundSyncDeferred: Boolean(normalized?.backgroundSyncDeferred),
    };
  }

  finalizeChapterContent(input: Parameters<ChapterContentFinalizationService["finalizeChapterContent"]>[0]): Promise<FinalizeChapterContentResult> {
    return this.deps.contentFinalizationService.finalizeChapterContent(input);
  }

  markChapterStatus(
    chapterId: string,
    chapterStatus: "pending_generation" | "generating" | "pending_review" | "needs_repair",
  ): Promise<void> {
    return this.deps.contentFinalizationService.markChapterStatus(chapterId, chapterStatus);
  }

  private assertStateDrivenReady(contextPackage: GenerationContextPackage, request: ChapterRuntimeRequestInput): void {
    if (contextPackage.nextAction === "hold_for_review") {
      const isFullBookAutopilot = request.controlPolicy?.advanceMode === "full_book_autopilot";
      const hasPendingStateProposals = contextPackage.pendingReviewProposalCount > 0;
      const hasOpenAuditIssues = contextPackage.openAuditIssues.length > 0;
      if (isFullBookAutopilot && hasPendingStateProposals && !hasOpenAuditIssues) {
        return;
      }
      const reasons = [
        contextPackage.pendingReviewProposalCount > 0
          ? `${contextPackage.pendingReviewProposalCount} pending state proposal(s)`
          : "",
        ...contextPackage.openAuditIssues.slice(0, 2).map((issue) => issue.description),
      ].filter(Boolean);
      throw new Error(
        `Chapter generation is blocked until review is resolved.${reasons.length > 0 ? ` ${reasons.join(" | ")}` : ""}`,
      );
    }
  }

  private async resolveWriterResultWithEmptyRetry(input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    assembled: AssembledRuntimeChapter;
    writerDone: () => Promise<{
      finalContent: string;
      lengthControl?: ChapterRuntimePackage["lengthControl"];
      artifactsAlreadySynced?: boolean;
      backgroundSyncDeferred?: boolean;
    } | void>;
    fallbackContent: string;
    signal?: AbortSignal;
  }): Promise<{
    finalContent: string;
    lengthControl?: ChapterRuntimePackage["lengthControl"];
    artifactsAlreadySynced?: boolean;
    backgroundSyncDeferred?: boolean;
  }> {
    try {
      const normalized = await input.writerDone();
      const finalContent = assertChapterContentNotEmpty(normalized?.finalContent ?? input.fallbackContent, {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.assembled.chapter.order,
        source: "chapter_stream_writer",
        attempt: 1,
        maxEmptyRetries: 1,
      });
      return {
        ...(normalized ?? {}),
        finalContent,
      };
    } catch (error) {
      if (isChapterEmptyContentError(error)) {
        this.logEmptyChapterContent({
          error,
          novelId: input.novelId,
          chapterId: input.chapterId,
          chapterOrder: input.assembled.chapter.order,
          request: input.request,
          willRetry: true,
          attempt: 1,
        });
      } else if (isChapterChineseProseGateError(error)) {
        this.logChineseProseGateFailure({
          error,
          novelId: input.novelId,
          chapterId: input.chapterId,
          chapterOrder: input.assembled.chapter.order,
          request: input.request,
          willRetry: true,
          attempt: 1,
        });
      } else {
        throw error;
      }
    }

    try {
      const retryDraft = await this.generateDraftFromWriter({
        novelId: input.novelId,
        chapterId: input.chapterId,
        request: input.request,
        assembled: input.assembled,
        signal: input.signal,
      });
      return {
        finalContent: retryDraft.content,
        lengthControl: retryDraft.lengthControl,
        artifactsAlreadySynced: retryDraft.artifactsAlreadySynced,
        backgroundSyncDeferred: retryDraft.backgroundSyncDeferred,
      };
    } catch (error) {
      if (isChapterEmptyContentError(error)) {
        this.logEmptyChapterContent({
          error,
          novelId: input.novelId,
          chapterId: input.chapterId,
          chapterOrder: input.assembled.chapter.order,
          request: input.request,
          willRetry: false,
          attempt: 2,
        });
        await this.markChapterStatus(input.chapterId, "pending_generation");
      } else if (isChapterChineseProseGateError(error)) {
        this.logChineseProseGateFailure({
          error,
          novelId: input.novelId,
          chapterId: input.chapterId,
          chapterOrder: input.assembled.chapter.order,
          request: input.request,
          willRetry: false,
          attempt: 2,
        });
        await this.markChapterStatus(input.chapterId, "pending_generation");
      }
      throw error;
    }
  }

  private logEmptyChapterContent(input: {
    error: ChapterEmptyContentError;
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    request: ChapterRuntimeRequestInput;
    willRetry: boolean;
    attempt: number;
  }): void {
    console.warn("[chapter-runtime] empty chapter content", {
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder,
      provider: input.request.provider,
      model: input.request.model,
      willRetry: input.willRetry,
      attempt: input.attempt,
      contentLength: input.error.details.trimmedLength,
      rawContentLength: input.error.details.rawLength,
      source: input.error.details.source,
    });
  }

  private logChineseProseGateFailure(input: {
    error: ChapterChineseProseGateError;
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    request: ChapterRuntimeRequestInput;
    willRetry: boolean;
    attempt: number;
  }): void {
    console.warn("[chapter-runtime] chinese prose gate failed", {
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder,
      provider: input.request.provider,
      model: input.request.model,
      willRetry: input.willRetry,
      attempt: input.attempt,
      reason: input.error.details.reason,
      metaMarker: input.error.details.metaMarker,
      cjkCount: input.error.details.cjkCount,
      latinCount: input.error.details.latinCount,
      rawContentLength: input.error.details.rawLength,
      source: input.error.details.source,
    });
  }

  private emitRunStatus(
    helpers: StreamDoneHelpers | undefined,
    payload: Extract<WritableSSEFrame, { type: "run_status" }>,
  ): void {
    helpers?.writeFrame(payload);
  }
}
