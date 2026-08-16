import type { BaseMessageChunk } from "@langchain/core/messages";
import type {
  ChapterRuntimePackage,
  GenerationContextPackage,
} from "@ai-novel/shared/types/chapterRuntime";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { TaskType } from "../../llm/modelRouter";
import { createContextBlock } from "../../prompting/core/contextBudget";
import { streamTextPrompt } from "../../prompting/core/promptRunner";
import { resolvePromptContextBlocksForAsset } from "../../prompting/context/promptContextResolution";
import {
  buildChapterWriterContextBlocks,
  resolveTargetWordRange,
  sanitizeWriterContextBlocks,
} from "../../prompting/prompts/novel/chapterLayeredContext";
import { chapterWriterPrompt } from "../../prompting/prompts/novel/chapterWriter.prompts";
import {
  NovelContinuationService,
  type ContinuationSimilarityDebt,
} from "./NovelContinuationService";
import { prisma } from "../../db/prisma";
import { assertChapterContentNotEmpty } from "./runtime/chapterEmptyContentError";
import { buildChapterChineseProseGateError } from "./runtime/chapterChineseProseGateError";
import { throwIfChapterGenerationAborted } from "./runtime/chapterAbortGuard";
import { assessChineseProse } from "../../utils/chineseProseGate";
import type { CommittedChapterContent } from "./runtime/content/ChapterContentCommitTypes";
import {
  buildDraftContinuationBlock,
  buildLengthInstruction,
  continuationEchoSimilarity,
  CONTINUATION_ECHO_SIMILARITY_THRESHOLD,
  countChapterCharacters,
  LENGTH_RECOVERY_MIN_USEFUL_DELTA_CHARS,
  trimContinuationOverlap,
} from "./runtime/writer/ChapterContinuationTextPolicy";

export { trimContinuationOverlap } from "./runtime/writer/ChapterContinuationTextPolicy";

/**
 * writer 单次 LLM 调用的墙钟预算，按目标字数线性放大。
 *
 * 背景（生产 P0）：12000 字目标章节用默认 300s/480s 预算，deepseek-v4-pro 流式
 * （~15-20 tok/s）根本写不完，单次调用必撞墙 → 此前超时还会打崩整个进程（已在
 * invokeTimeout 修复崩溃）。这里给 writer 一个随 target 放大的预算：
 * - 经验吞吐按 ~25 字/秒保守估计（CJK 长章 deepseek-v4-pro 偏慢），
 * - 再乘 1.6 安全裕度覆盖首 token 延迟 + 慢渠道，
 * - 下限 480s（短章不退化），上限 1500s（仍受 invokeTimeout env 3600s 钳制内）。
 * 只对 writer 传显式 timeoutMs；其它 prompt 调用方仍走 DEFAULT_ENFORCED_TIMEOUT_MS。
 */
const WRITER_TIMEOUT_MIN_MS = 480_000;
const WRITER_TIMEOUT_MAX_MS = 1_500_000;
const WRITER_CHARS_PER_SECOND = 25;
const WRITER_TIMEOUT_HEADROOM = 1.6;

function resolveWriterTimeoutMs(targetWordCount?: number | null): number {
  const target = typeof targetWordCount === "number" && Number.isFinite(targetWordCount)
    ? Math.max(0, targetWordCount)
    : 0;
  if (target <= 0) {
    return WRITER_TIMEOUT_MIN_MS;
  }
  const estimated = (target / WRITER_CHARS_PER_SECOND) * 1000 * WRITER_TIMEOUT_HEADROOM;
  return Math.min(WRITER_TIMEOUT_MAX_MS, Math.max(WRITER_TIMEOUT_MIN_MS, Math.ceil(estimated)));
}

/** 判断错误是否墙钟超时（TimeoutError），用于 writer 阶段观测日志归类。 */
function isWriterTimeoutError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "TimeoutError" || /timed out after \d+ms/i.test(error.message));
}

/**
 * 剥离 writer 模型误输出到正文尾部的「自检答复」块。
 * 部分模型（如 gemini-3.7-flash-high）无视 prompt「不需要在正文中输出核查结果」，
 * 把开头形如「已确认满足全部要求：1.…2.…3.…」的验收清单直接接在正文后，
 * 若原样落库会被 quality-debt 审成说明句/八股打回。
 * 判别标准：自检块只占正文尾部极小比例（实测约 1.7%，上限 10%）；若某 marker 出现在
 * 文中/中段，其后必跟大段正文，占比远超 10%，不剥。以此避免误伤正文内对术语的引用。
 */
const SELF_CHECK_LEAK_MARKERS = [
  "已确认满足全部要求",
  "确认满足全部要求",
  "已满足全部要求",
  "自查结果：",
  "自查结果:",
  "核查结果：",
  "核查结果:",
];

function stripTrailingSelfCheckReport(content: string): string {
  const trimmed = content.trimEnd();
  if (!trimmed) {
    return content;
  }
  let cut = -1;
  for (const marker of SELF_CHECK_LEAK_MARKERS) {
    const idx = trimmed.lastIndexOf(marker);
    if (idx < 0) {
      continue;
    }
    const fracAfter = (trimmed.length - idx) / trimmed.length;
    if (fracAfter > 0.1) {
      continue;
    }
    if (cut === -1 || idx < cut) {
      cut = idx;
    }
  }
  if (cut < 0) {
    return content;
  }
  // 回退到该 marker 段落前的空行（若存在），整体剥掉自检块，保留正文。
  const blankBefore = trimmed.lastIndexOf("\n\n", cut);
  const from = blankBefore >= 0 ? blankBefore + 2 : cut;
  const cleaned = trimmed.slice(0, from).trimEnd();
  if (!cleaned) {
    return content;
  }
  return cleaned;
}

export interface ChapterGraphLLMOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  taskType?: TaskType;
  /** 导演 / pipeline 取消穿透：中断 LLM 流，避免取消后继续定稿发布 */
  signal?: AbortSignal;
}

export interface ChapterGraphGenerateOptions extends ChapterGraphLLMOptions {
  previousChaptersSummary?: string[];
  deferArtifactBackgroundSync?: boolean;
}

interface ChapterRef {
  id: string;
  title: string;
  order: number;
  contentRevision: number;
  content?: string | null;
  expectation?: string | null;
  targetWordCount?: number | null;
}

type ContinuationPack = Awaited<ReturnType<NovelContinuationService["buildChapterContextPack"]>>;

interface ChapterLengthDebt {
  targetWordCount: number;
  minWordCount: number;
  finalWordCount: number;
  attempts: number;
}

interface ChapterGraphDeps {
  enforceOpeningDiversity: (
    novelId: string,
    chapterOrder: number,
    chapterTitle: string,
    content: string,
    options: ChapterGraphLLMOptions,
  ) => Promise<{ content: string; rewritten: boolean; maxSimilarity: number }>;
  saveDraftAndArtifacts: (
    novelId: string,
    chapterId: string,
    content: string,
    generationState: "drafted",
    options: {
      expectedContentRevision: number;
      scheduleBackgroundSync?: boolean;
      syncArtifacts?: boolean;
    },
  ) => Promise<CommittedChapterContent>;
  logInfo: (message: string, meta?: Record<string, unknown>) => void;
  logWarn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ChapterStreamInput {
  novelId: string;
  novelTitle: string;
  chapter: ChapterRef;
  contextPackage?: GenerationContextPackage;
  options: ChapterGraphGenerateOptions;
}

// Lazy: top-level `new NovelContinuationService()` re-enters this module mid-load
// via promptRunner → director → ChapterRuntimeCoordinator → chapterWritingGraph
// while NovelContinuationService exports are still incomplete (CJS cycle).
let continuationServiceSingleton: NovelContinuationService | null = null;
function getContinuationService(): NovelContinuationService {
  if (!continuationServiceSingleton) {
    continuationServiceSingleton = new NovelContinuationService();
  }
  return continuationServiceSingleton;
}

export class ChapterWritingGraph {
  constructor(private readonly deps: ChapterGraphDeps) {}

  /** 仅在正文 CAS 成功后，把候选质量债投影到该次提交拥有的 revision。 */
  private async persistCommittedDraftRiskFlags(input: {
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    contentRevision: number;
    lengthDebt?: ChapterLengthDebt;
    continuationSimilarityDebt?: ContinuationSimilarityDebt;
  }): Promise<void> {
    if (!input.lengthDebt && !input.continuationSimilarityDebt) {
      return;
    }
    try {
      const existing = await prisma.chapter.findFirst({
        where: {
          id: input.chapterId,
          novelId: input.novelId,
          contentRevision: input.contentRevision,
        },
        select: { riskFlags: true },
      });
      if (!existing) {
        return;
      }
      let parsed: Record<string, unknown> = {};
      if (existing?.riskFlags?.trim()) {
        try {
          const value = JSON.parse(existing.riskFlags) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            parsed = value as Record<string, unknown>;
          }
        } catch {
          parsed = {};
        }
      }
      await prisma.chapter.updateMany({
        where: {
          id: input.chapterId,
          novelId: input.novelId,
          contentRevision: input.contentRevision,
        },
        data: {
          riskFlags: JSON.stringify({
            ...parsed,
            ...(input.continuationSimilarityDebt
              ? {
                  continuationUnresolvedHighSimilarity: {
                    at: new Date().toISOString(),
                    ...input.continuationSimilarityDebt,
                  },
                }
              : {}),
            ...(input.lengthDebt
              ? {
                  chapterLengthDebt: {
                    at: new Date().toISOString(),
                    chapterOrder: input.chapterOrder,
                    ...input.lengthDebt,
                  },
                }
              : {}),
          }),
        },
      });
    } catch (error) {
      this.deps.logWarn("persist committed draft riskFlags failed", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        contentRevision: input.contentRevision,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * broker 解析结果健康检查：
   * - 仅当 **required** 组的 resolver 抛错时 fail-fast（缺骨上下文会写出失控章节）。
   * - 可选组 resolver 错误、以及 missingRequiredGroups 中「resolver 正常返回空」的合法空组
   *   （裸章节 obligation_contract / 无风格基线 style_contract 等）只 logWarn，不阻断。
   */
  private assertBrokerResolutionHealthy(
    brokerResolution: {
      missingRequiredGroups: string[];
      resolverErrors: Array<{ group: string; message: string }>;
    },
    context: { novelId: string; chapterId: string; chapterOrder: number },
    stage: "writer_draft" | "writer_extend",
  ): void {
    const baseMeta = {
      novelId: context.novelId,
      chapterId: context.chapterId,
      chapterOrder: context.chapterOrder,
      stage,
    };
    if (brokerResolution.missingRequiredGroups.length > 0) {
      this.deps.logWarn("Context broker missing required groups", {
        ...baseMeta,
        missingRequiredGroups: brokerResolution.missingRequiredGroups,
      });
    }
    if (brokerResolution.resolverErrors.length === 0) {
      return;
    }
    this.deps.logWarn("Context broker resolver errors", {
      ...baseMeta,
      resolverErrors: brokerResolution.resolverErrors,
    });
    // 可选组 resolver 失败不得阻断写章；仅 required ∩ resolverErrors 才 throw。
    const failedRequiredGroups = new Set(brokerResolution.resolverErrors.map((error) => error.group));
    const failedMissing = brokerResolution.missingRequiredGroups.filter((group) => failedRequiredGroups.has(group));
    if (failedMissing.length === 0) {
      return;
    }
    throw new Error(
      `小说${context.novelId} 章节${context.chapterOrder} 写章上下文必需组解析失败（${stage}）: ${failedMissing.join(", ")}`,
    );
  }

  private async continuityNode(
    novelId: string,
    chapter: ChapterRef,
    content: string,
    options: ChapterGraphLLMOptions,
    continuationPack: ContinuationPack,
  ): Promise<{ content: string; similarityDebt?: ContinuationSimilarityDebt }> {
    throwIfChapterGenerationAborted(options.signal, "章节生成已取消。");
    const openingGuard = await this.deps.enforceOpeningDiversity(
      novelId,
      chapter.order,
      chapter.title,
      content,
      options,
    );
    throwIfChapterGenerationAborted(options.signal, "章节生成已取消。");
    if (openingGuard.rewritten) {
      this.deps.logInfo("Opening diversity rewrite applied", {
        chapterOrder: chapter.order,
        maxSimilarity: Number(openingGuard.maxSimilarity.toFixed(4)),
      });
    }

    const continuationGuard = await getContinuationService().rewriteIfTooSimilar({
      chapterTitle: chapter.title,
      content: openingGuard.content,
      continuationPack,
      provider: options.provider,
      model: options.model,
      temperature: options.temperature,
      signal: options.signal,
      novelId,
      chapterId: chapter.id,
    });
    if (continuationGuard.rewritten) {
      this.deps.logInfo("Continuation anti-copy rewrite applied", {
        chapterOrder: chapter.order,
        maxSimilarity: Number(continuationGuard.maxSimilarity.toFixed(4)),
      });
    }
    return {
      content: continuationGuard.content,
      similarityDebt: continuationGuard.unresolvedSimilarityDebt,
    };
  }

  private async enforceTargetLength(input: {
    novelId: string;
    novelTitle: string;
    chapter: ChapterRef;
    content: string;
    contextPackage: GenerationContextPackage;
    options: ChapterGraphLLMOptions;
  }): Promise<{
    content: string;
    /** 仍低于 minWordCount 时的欠账记录（长度兜底未补齐） */
    lengthDebt?: ChapterLengthDebt;
  }> {
    throwIfChapterGenerationAborted(input.options.signal, "章节生成已取消。");
    const writeContext = input.contextPackage.chapterWriteContext;
    const lengthGoal = buildLengthInstruction(
      writeContext?.chapterMission.targetWordCount
      ?? input.contextPackage.chapter.targetWordCount
      ?? input.chapter.targetWordCount
      ?? null,
    );
    if (!writeContext || lengthGoal.targetWordCount == null || lengthGoal.minWordCount == null) {
      return { content: input.content };
    }

    let content = input.content;
    let currentLength = countChapterCharacters(content);
    if (currentLength >= lengthGoal.minWordCount) {
      return { content };
    }

    const builtBlocks = buildChapterWriterContextBlocks(writeContext);
    const maxAttempts = 2;
    let attemptsUsed = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsUsed = attempt;
      throwIfChapterGenerationAborted(input.options.signal, "章节生成已取消。");
      const missingWordGap = Math.max(
        lengthGoal.targetWordCount - currentLength,
        lengthGoal.minWordCount - currentLength,
      );
      const sanitized = sanitizeWriterContextBlocks([
        createContextBlock({
          id: "current_draft_excerpt",
          group: "current_draft_excerpt",
          priority: 99,
          required: true,
          content: buildDraftContinuationBlock(
            content,
            lengthGoal.targetWordCount,
            lengthGoal.minWordCount,
          ),
        }),
        ...builtBlocks,
      ]);
      if (sanitized.removedBlockIds.length > 0) {
        this.deps.logWarn("Writer continuation blocks removed by guard", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          removedBlockIds: sanitized.removedBlockIds,
        });
      }
      const resolvedContext = await resolvePromptContextBlocksForAsset({
        asset: chapterWriterPrompt,
        executionContext: {
          entrypoint: "chapter_pipeline",
          novelId: input.novelId,
          chapterId: input.chapter.id,
          metadata: {
            chapterWriteContext: writeContext,
            chapterBlockMode: "full",
            ragContext: input.contextPackage.ragContext,
            extraContextBlocks: sanitized.allowedBlocks.filter((block) => block.group === "current_draft_excerpt"),
          },
        },
        fallbackBlocks: sanitized.allowedBlocks,
        log: (message, meta) => this.deps.logWarn(message, {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          ...meta,
        }),
      });
      this.assertBrokerResolutionHealthy(
        resolvedContext.brokerResolution,
        { novelId: input.novelId, chapterId: input.chapter.id, chapterOrder: input.chapter.order },
        "writer_extend",
      );

      // P2 修复：续写改走 streamTextPrompt。旧 runTextPrompt 非流式整段等待，建立请求无
      // transport retry、无 live 进度，body 静默 hang 只能等墙钟兜底；流式与 writer_draft
      // 同构——establish 走 runWithTransportRetry，token 逐个进 live session，超时/abort 语义一致。
      const extendTimeoutMs = resolveWriterTimeoutMs(Math.max(missingWordGap, lengthGoal.minWordCount ?? 0));
      const extendStartedAt = Date.now();
      // P3 观测：writer 每阶段 start/complete/fail 结构化日志，超时单独归类，
      // 让「慢」与「挂」在日志里一眼可分（不再只能事后翻 err.log 对时间戳）。
      this.deps.logInfo("Writer stage started", {
        novelId: input.novelId,
        chapterId: input.chapter.id,
        chapterOrder: input.chapter.order,
        stage: "writer_extend",
        attempt,
        currentLength,
        missingWordGap,
        timeoutMs: extendTimeoutMs,
        provider: input.options.provider ?? null,
        model: input.options.model ?? null,
      });
      let continuationStream: Awaited<ReturnType<typeof streamTextPrompt>>;
      try {
        continuationStream = await streamTextPrompt({
        asset: chapterWriterPrompt,
        promptInput: {
          novelTitle: input.novelTitle,
          chapterOrder: input.chapter.order,
          chapterTitle: input.chapter.title,
          mode: "continue",
          targetWordCount: lengthGoal.targetWordCount,
          minWordCount: lengthGoal.minWordCount,
          maxWordCount: lengthGoal.maxWordCount,
          missingWordGap,
        },
        contextBlocks: resolvedContext.blocks,
        options: {
          provider: input.options.provider,
          model: input.options.model,
          temperature: input.options.temperature ?? 0.8,
          // 续写只需补 missingWordGap，但仍给整章量级预算的保守下界，避免短 gap 撞 480s 墙。
          timeoutMs: extendTimeoutMs,
          novelId: input.novelId,
          chapterId: input.chapter.id,
          stage: "writer_extend",
          triggerReason: "length_recovery",
          signal: input.options.signal,
        },
      });
      } catch (error) {
        this.deps.logWarn("Writer stage failed (establish)", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          stage: "writer_extend",
          attempt,
          kind: isWriterTimeoutError(error) ? "timeout" : "error",
          latencyMs: Date.now() - extendStartedAt,
          timeoutMs: extendTimeoutMs,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      // 与 writer_draft onDone 同理：不吞 complete 的 reject。超时/abort 时若有 partial buffer
      // 也不能冒充成功续写段——直接让 reject 冒泡为章节失败（可恢复），不落半截文字。
      let continuationCompleted: Awaited<typeof continuationStream.complete>;
      try {
        continuationCompleted = await continuationStream.complete;
      } catch (error) {
        this.deps.logWarn("Writer stage failed (stream)", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          stage: "writer_extend",
          attempt,
          kind: isWriterTimeoutError(error) ? "timeout" : "error",
          latencyMs: Date.now() - extendStartedAt,
          timeoutMs: extendTimeoutMs,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      this.deps.logInfo("Writer stage completed", {
        novelId: input.novelId,
        chapterId: input.chapter.id,
        chapterOrder: input.chapter.order,
        stage: "writer_extend",
        attempt,
        latencyMs: Date.now() - extendStartedAt,
        outputChars: (continuationCompleted?.output ?? "").trim().length,
      });
      let appended = (continuationCompleted?.output ?? "").trim();
      if (!appended) {
        // 空输出视为本轮失败：还有重试额度则再来一次，否则记欠账
        this.deps.logWarn("Writer continuation returned empty output", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          attempt,
        });
        continue;
      }

      // 复读检测：先裁掉与草稿尾的最长公共前缀，再做 n-gram 回声检查
      const draftTail = content.trim().slice(-1400);
      appended = trimContinuationOverlap(draftTail, appended);
      if (!appended) {
        this.deps.logWarn("Writer continuation discarded: fully overlaps draft tail", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          attempt,
        });
        continue;
      }
      const echoSimilarity = continuationEchoSimilarity(draftTail, appended);
      if (echoSimilarity >= CONTINUATION_ECHO_SIMILARITY_THRESHOLD) {
        this.deps.logWarn("Writer continuation discarded: echo of draft tail detected", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          attempt,
          echoSimilarity: Number(echoSimilarity.toFixed(4)),
        });
        continue;
      }

      const proseGate = assessChineseProse(appended);
      if (!proseGate.ok) {
        this.deps.logWarn("Writer continuation discarded: Chinese prose gate failed", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          attempt,
          reason: proseGate.reason,
          metaMarker: proseGate.metaMarker,
          cjkCount: proseGate.cjkCount,
          latinCount: proseGate.latinCount,
        });
        continue;
      }

      const merged = `${content.trim()}\n\n${appended}`.trim();
      const mergedLength = countChapterCharacters(merged);
      const usefulDelta = mergedLength - currentLength;
      this.deps.logInfo("Chapter draft auto-extended for target length", {
        novelId: input.novelId,
        chapterId: input.chapter.id,
        chapterOrder: input.chapter.order,
        attempt,
        beforeLength: currentLength,
        afterLength: mergedLength,
        usefulDelta,
        targetWordCount: lengthGoal.targetWordCount,
        minWordCount: lengthGoal.minWordCount,
      });
      // Tiny net growth after echo/overlap trim is padding thrash — stop early.
      if (usefulDelta < LENGTH_RECOVERY_MIN_USEFUL_DELTA_CHARS) {
        this.deps.logWarn("Writer continuation stopped: useful delta below threshold", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          attempt,
          usefulDelta,
          minUsefulDelta: LENGTH_RECOVERY_MIN_USEFUL_DELTA_CHARS,
        });
        if (usefulDelta > 0) {
          content = merged;
          currentLength = mergedLength;
        }
        break;
      }
      content = merged;
      currentLength = mergedLength;
      if (currentLength >= lengthGoal.minWordCount) {
        return { content };
      }
    }

    if (currentLength < lengthGoal.minWordCount) {
      this.deps.logWarn("Chapter length target unmet after continuation attempts", {
        novelId: input.novelId,
        chapterId: input.chapter.id,
        chapterOrder: input.chapter.order,
        targetWordCount: lengthGoal.targetWordCount,
        minWordCount: lengthGoal.minWordCount,
        finalWordCount: currentLength,
        attempts: attemptsUsed,
      });
      return {
        content,
        lengthDebt: {
          targetWordCount: lengthGoal.targetWordCount,
          minWordCount: lengthGoal.minWordCount,
          finalWordCount: currentLength,
          attempts: attemptsUsed,
        },
      };
    }
    return { content };
  }

  async createChapterStream(input: ChapterStreamInput): Promise<{
    stream: AsyncIterable<BaseMessageChunk>;
    onDone: (fullContent: string) => Promise<{
      finalContent: string;
      lengthControl?: ChapterRuntimePackage["lengthControl"];
      artifactsAlreadySynced?: boolean;
      backgroundSyncDeferred?: boolean;
      contentRevision?: number;
    } | void>;
  }> {
    const continuationPack = (input.contextPackage?.continuation as ContinuationPack | undefined)
      ?? await getContinuationService().buildChapterContextPack(input.novelId);
    const chapterWriteContext = input.contextPackage?.chapterWriteContext;
    if (!input.contextPackage || !chapterWriteContext) {
      throw new Error("Chapter runtime context is required before chapter generation.");
    }
    const contextPackage = input.contextPackage;
    const targetRange = resolveTargetWordRange(chapterWriteContext.chapterMission.targetWordCount);
    const builtBlocks = buildChapterWriterContextBlocks(chapterWriteContext);
    const sanitized = sanitizeWriterContextBlocks(builtBlocks);
    if (sanitized.removedBlockIds.length > 0) {
      this.deps.logWarn("Writer context blocks removed by guard", {
        novelId: input.novelId,
        chapterId: input.chapter.id,
        chapterOrder: input.chapter.order,
        removedBlockIds: sanitized.removedBlockIds,
      });
    }
    const resolvedContext = await resolvePromptContextBlocksForAsset({
      asset: chapterWriterPrompt,
      executionContext: {
        entrypoint: "chapter_pipeline",
        novelId: input.novelId,
        chapterId: input.chapter.id,
        metadata: {
          chapterWriteContext,
          chapterBlockMode: "full",
          ragContext: contextPackage.ragContext,
        },
      },
      fallbackBlocks: sanitized.allowedBlocks,
      log: (message, meta) => this.deps.logWarn(message, {
        novelId: input.novelId,
        chapterId: input.chapter.id,
        chapterOrder: input.chapter.order,
        ...meta,
      }),
    });
    this.assertBrokerResolutionHealthy(
      resolvedContext.brokerResolution,
      { novelId: input.novelId, chapterId: input.chapter.id, chapterOrder: input.chapter.order },
      "writer_draft",
    );

    // P3 观测：writer_draft 同样记 start/fail（complete 在 onDone 侧记录产出字数）。
    const draftTimeoutMs = resolveWriterTimeoutMs(
      chapterWriteContext.chapterMission.targetWordCount ?? targetRange.minWordCount,
    );
    const draftStartedAt = Date.now();
    this.deps.logInfo("Writer stage started", {
      novelId: input.novelId,
      chapterId: input.chapter.id,
      chapterOrder: input.chapter.order,
      stage: "writer_draft",
      targetWordCount: chapterWriteContext.chapterMission.targetWordCount ?? null,
      timeoutMs: draftTimeoutMs,
      provider: input.options.provider ?? null,
      model: input.options.model ?? null,
    });
    let streamed: Awaited<ReturnType<typeof streamTextPrompt>>;
    try {
      streamed = await streamTextPrompt({
      asset: chapterWriterPrompt,
      promptInput: {
        novelTitle: input.novelTitle,
        chapterOrder: input.chapter.order,
        chapterTitle: input.chapter.title,
        mode: "draft",
        targetWordCount: chapterWriteContext.chapterMission.targetWordCount ?? null,
        minWordCount: targetRange.minWordCount,
        maxWordCount: targetRange.maxWordCount,
      },
      contextBlocks: resolvedContext.blocks,
      options: {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature ?? 0.8,
        maxTokens: undefined,
        // 整章 draft 给按 target 放大的预算：12000 字 ≈ 768s，远超旧 480s 默认。
        timeoutMs: draftTimeoutMs,
        novelId: input.novelId,
        chapterId: input.chapter.id,
        stage: "writer_draft",
        triggerReason: "chapter_initial_draft",
        signal: input.options.signal,
      },
      });
    } catch (error) {
      this.deps.logWarn("Writer stage failed (establish)", {
        novelId: input.novelId,
        chapterId: input.chapter.id,
        chapterOrder: input.chapter.order,
        stage: "writer_draft",
        kind: isWriterTimeoutError(error) ? "timeout" : "error",
        latencyMs: Date.now() - draftStartedAt,
        timeoutMs: draftTimeoutMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return {
      stream: streamed.stream as AsyncIterable<BaseMessageChunk>,
      onDone: async (fullContent: string) => {
        // 已取消：禁止 onDone 路径继续定稿/落库（避免 partial final publish）
        throwIfChapterGenerationAborted(input.options.signal);
        // 不吞 streamed.complete 的 reject：writer 无 postValidate，成功时 output===fullContent；
        // reject 只来自超时/abort/iterator error，此时若回退 partial buffer 落库，会把截断章
        // 冒充成功定稿。直接 await 让 reject 冒泡 → resolveWriterResultWithEmptyRetry 原样上抛
        // → 任务失败（可恢复），不再静默持久化半截正文。?? fullContent 仅兜 resolve 后空值边界。
        let completed: Awaited<typeof streamed.complete>;
        try {
          completed = await streamed.complete;
        } catch (error) {
          this.deps.logWarn("Writer stage failed (stream)", {
            novelId: input.novelId,
            chapterId: input.chapter.id,
            chapterOrder: input.chapter.order,
            stage: "writer_draft",
            kind: isWriterTimeoutError(error) ? "timeout" : "error",
            latencyMs: Date.now() - draftStartedAt,
            timeoutMs: draftTimeoutMs,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        // 防模型把自检答复/验收清单接在正文尾部泄漏：落库前剥离，避免被 quality-debt 审成八股。
        const rawContent = stripTrailingSelfCheckReport(completed?.output ?? fullContent);
        this.deps.logInfo("Writer stage completed", {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          stage: "writer_draft",
          latencyMs: Date.now() - draftStartedAt,
          outputChars: rawContent.length,
        });
        const normalized = await this.continuityNode(
          input.novelId,
          input.chapter,
          rawContent,
          input.options,
          continuationPack,
        );
        const lengthAdjusted = await this.enforceTargetLength({
          novelId: input.novelId,
          novelTitle: input.novelTitle,
          chapter: input.chapter,
          content: normalized.content,
          contextPackage,
          options: input.options,
        });
        if (lengthAdjusted.lengthDebt) {
          // 先记录日志；riskFlags 必须等正文 CAS 成功后再按 committed revision 投影。
          this.deps.logWarn("Chapter length debt recorded", {
            novelId: input.novelId,
            chapterId: input.chapter.id,
            chapterOrder: input.chapter.order,
            ...lengthAdjusted.lengthDebt,
          });
        }
        const chineseGate = assessChineseProse(lengthAdjusted.content);
        if (!chineseGate.ok) {
          this.deps.logWarn("Chapter writer Chinese prose hard gate failed", {
            novelId: input.novelId,
            chapterId: input.chapter.id,
            chapterOrder: input.chapter.order,
            reason: chineseGate.reason,
            metaMarker: chineseGate.metaMarker,
            cjkCount: chineseGate.cjkCount,
            latinCount: chineseGate.latinCount,
          });
          throw buildChapterChineseProseGateError(lengthAdjusted.content, chineseGate, {
            novelId: input.novelId,
            chapterId: input.chapter.id,
            chapterOrder: input.chapter.order,
            source: "chapter_writer",
          });
        }
        const safeContent = assertChapterContentNotEmpty(lengthAdjusted.content, {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          source: "chapter_writer",
        });
        const committedDraft = await this.deps.saveDraftAndArtifacts(
          input.novelId,
          input.chapter.id,
          safeContent,
          "drafted",
          {
            expectedContentRevision: input.chapter.contentRevision,
            scheduleBackgroundSync: !input.options.deferArtifactBackgroundSync,
            syncArtifacts: false,
          },
        );
        await this.persistCommittedDraftRiskFlags({
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          contentRevision: committedDraft.contentRevision,
          lengthDebt: lengthAdjusted.lengthDebt,
          continuationSimilarityDebt: normalized.similarityDebt,
        });
        return {
          finalContent: safeContent,
          artifactsAlreadySynced: true,
          backgroundSyncDeferred: Boolean(input.options.deferArtifactBackgroundSync),
          contentRevision: committedDraft.contentRevision,
        };
      },
    };
  }
}
