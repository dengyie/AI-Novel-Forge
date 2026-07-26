import type { BaseMessageChunk } from "@langchain/core/messages";
import { isAutoPatchAvoidedByRiskFlags } from "@ai-novel/shared/types/qualityFeedback";
import type { StreamDoneHelpers } from "../../../../../llm/streaming";
import { prisma } from "../../../../../db/prisma";
import { streamTextPrompt } from "../../../../../prompting/core/promptRunner";
import { withChapterRepairContext } from "../../../../../prompting/prompts/novel/chapterLayeredContext";
import { logPipelineError, logPipelineInfo, type RepairOptions } from "../../../novelCoreShared";
import type { ChapterArtifactSyncService } from "../../ChapterArtifactSyncService";
import type { ChapterContentCommitService } from "../../content/ChapterContentCommitService";
import type { GenerationContextAssembler } from "../../GenerationContextAssembler";
import {
  ChapterContextAssemblyError,
  assembleChapterAuditContextPackage,
} from "../chapterAuditContext";
import {
  createHeavyRepairPromptExecution,
  prepareChapterRepairExecution,
} from "../chapterRepairRuntime";
import { assertRepairAbortSignal } from "../concurrency/ChapterRepairCancellation";
import { acquireChapterRepairLock } from "../concurrency/ChapterRepairLock";
import type { ReviewChapterAfterRepair } from "../evaluation/ChapterRepairBaselineEvaluator";
import { ChapterRepairIssueResolver } from "../evaluation/ChapterRepairIssueResolver";
import { ChapterRepairFinalizer } from "./ChapterRepairFinalizer";

export interface ChapterRepairStreamOrchestratorDeps {
  assembler?: Pick<GenerationContextAssembler, "assemble">;
  contentCommitService: Pick<ChapterContentCommitService, "commit">;
  artifactSyncService: Pick<ChapterArtifactSyncService, "syncChapterArtifacts">;
  reviewChapterAfterRepair: ReviewChapterAfterRepair;
  resolveAuditIssues?: (novelId: string, issueIds: string[]) => Promise<unknown>;
}

export class ChapterRepairStreamOrchestrator {
  private readonly issueResolver: ChapterRepairIssueResolver;
  private readonly finalizer: ChapterRepairFinalizer;

  constructor(private readonly deps: ChapterRepairStreamOrchestratorDeps) {
    this.issueResolver = new ChapterRepairIssueResolver(deps.reviewChapterAfterRepair);
    this.finalizer = new ChapterRepairFinalizer(deps);
  }

  async createRepairStream(
    novelId: string,
    chapterId: string,
    options: RepairOptions = {},
  ): Promise<{
    stream: AsyncIterable<BaseMessageChunk>;
    onDone: (fullContent: string, helpers: StreamDoneHelpers) => Promise<void>;
  }> {
    const releaseRepairLock = await acquireChapterRepairLock(chapterId);
    let settled = false;
    let handedToCaller = false;
    const releaseOnce = (): void => {
      if (settled) return;
      settled = true;
      releaseRepairLock();
    };
    const assertRepairSignal = (step: string): void => {
      assertRepairAbortSignal(step, options.signal);
    };
    const guardStream = (
      source: AsyncIterable<BaseMessageChunk>,
    ): AsyncIterable<BaseMessageChunk> => (async function* guardedRepairStream() {
      let naturalEnd = false;
      try {
        for await (const chunk of source) yield chunk;
        naturalEnd = true;
      } finally {
        if (!naturalEnd) releaseOnce();
      }
    })();
    const handoff = (
      stream: AsyncIterable<BaseMessageChunk>,
      onDone: (fullContent: string, helpers: StreamDoneHelpers) => Promise<void>,
    ) => {
      assertRepairSignal("handoff");
      handedToCaller = true;
      return {
        stream: guardStream(stream),
        onDone: async (fullContent: string, helpers: StreamDoneHelpers) => {
          try {
            await onDone(fullContent, helpers);
          } finally {
            releaseOnce();
          }
        },
      };
    };

    try {
      assertRepairSignal("acquire");
      const [novel, chapter, bible] = await Promise.all([
        prisma.novel.findUnique({ where: { id: novelId } }),
        prisma.chapter.findFirst({ where: { id: chapterId, novelId } }),
        prisma.novelBible.findUnique({ where: { novelId } }),
      ]);
      assertRepairSignal("load-entities");
      if (!novel || !chapter) throw new Error("小说或章节不存在");
      const baselineContentRevision = chapter.contentRevision;

      const issues = await this.issueResolver.resolve(novelId, chapterId, options);
      assertRepairSignal("resolve-issues");
      const assembledContextPackage = await assembleChapterAuditContextPackage({
        assembler: this.deps.assembler,
        novelId,
        chapterId,
        options,
        operation: "repair",
      });
      assertRepairSignal("assemble-context");
      const repairContextPackage = withChapterRepairContext(assembledContextPackage, issues);
      if (!repairContextPackage.chapterRepairContext) {
        const error = new Error("chapterRepairContext missing after successful context assembly");
        logPipelineError("Failed to derive repair context from assembled chapter context package.", {
          novelId,
          chapterId,
          operation: "repair",
          provider: options.provider ?? null,
          model: options.model ?? null,
          error: error.message,
        });
        throw new ChapterContextAssemblyError(novelId, chapterId, "repair", error);
      }

      const patchAvoid = isAutoPatchAvoidedByRiskFlags(chapter.riskFlags);
      if (patchAvoid.avoided) {
        logPipelineInfo("QFP avoidRetry: forcing full rewrite instead of auto patch.", {
          novelId,
          chapterId,
          operation: "repair",
          provider: options.provider ?? null,
          model: options.model ?? null,
          reason: patchAvoid.reason,
        });
      }
      const prepared = await prepareChapterRepairExecution({
        novelId,
        chapterId,
        novelTitle: novel.title,
        chapterTitle: chapter.title,
        content: chapter.content ?? "",
        issues,
        repairContext: repairContextPackage.chapterRepairContext,
        bibleContent: bible?.rawContent ?? "",
        forceFullRewrite: patchAvoid.avoided,
        auditOpenIssueCodes: (assembledContextPackage.openAuditIssues ?? [])
          .map((item) => item?.code)
          .filter((code): code is string => typeof code === "string" && code.trim().length > 0),
        options: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature,
          repairMode: patchAvoid.avoided ? "heavy_repair" : options.repairMode,
          signal: options.signal,
        },
      });
      assertRepairSignal("prepare");

      if (prepared.kind === "patched") {
        return handoff(
          createSingleChunkStream(prepared.content),
          async (_fullContent, helpers) => this.finalizer.finalize({
            novelId,
            chapterId,
            baselineContentRevision,
            options,
            content: prepared.content,
            helpers,
          }),
        );
      }

      const streamed = await streamTextPrompt(createHeavyRepairPromptExecution(prepared));
      assertRepairSignal("stream-open");
      return handoff(
        streamed.stream as AsyncIterable<BaseMessageChunk>,
        async (_fullContent, helpers) => {
          const completed = await streamed.complete;
          await this.finalizer.finalize({
            novelId,
            chapterId,
            baselineContentRevision,
            options,
            content: completed.output,
            helpers,
          });
        },
      );
    } catch (error) {
      if (!handedToCaller) releaseOnce();
      throw error;
    }
  }
}

async function* createSingleChunkStream(content: string): AsyncIterable<BaseMessageChunk> {
  yield { content } as BaseMessageChunk;
}
