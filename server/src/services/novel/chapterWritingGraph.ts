import type { BaseMessageChunk } from "@langchain/core/messages";
import type {
  ChapterRuntimePackage,
  GenerationContextPackage,
} from "@ai-novel/shared/types/chapterRuntime";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { TaskType } from "../../llm/modelRouter";
import { createContextBlock } from "../../prompting/core/contextBudget";
import { runTextPrompt, streamTextPrompt } from "../../prompting/core/promptRunner";
import { resolvePromptContextBlocksForAsset } from "../../prompting/context/promptContextResolution";
import {
  buildChapterWriterContextBlocks,
  resolveTargetWordRange,
  sanitizeWriterContextBlocks,
} from "../../prompting/prompts/novel/chapterLayeredContext";
import { chapterWriterPrompt } from "../../prompting/prompts/novel/chapterWriter.prompts";
import { NovelContinuationService } from "./NovelContinuationService";
import { prisma } from "../../db/prisma";
import { assertChapterContentNotEmpty } from "./runtime/chapterEmptyContentError";
import { throwIfChapterGenerationAborted } from "./runtime/chapterAbortGuard";
import { buildNGramSet, jaccardSimilarity } from "@ai-novel/shared/utils/textSimilarity";

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
  content?: string | null;
  expectation?: string | null;
  targetWordCount?: number | null;
}

type ContinuationPack = Awaited<ReturnType<NovelContinuationService["buildChapterContextPack"]>>;

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
    generationState: "drafted" | "repaired",
    options?: { scheduleBackgroundSync?: boolean; syncArtifacts?: boolean },
  ) => Promise<void>;
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

const continuationService = new NovelContinuationService();

function countChapterCharacters(content: string): number {
  return content.replace(/\s+/g, "").trim().length;
}

function buildLengthInstruction(targetWordCount?: number | null): {
  targetWordCount: number | null;
  minWordCount: number | null;
  maxWordCount: number | null;
  instruction: string;
} {
  const range = resolveTargetWordRange(targetWordCount);
  if (range.targetWordCount == null) {
    return {
      ...range,
      instruction: "Write a complete readable chapter with enough concrete events and scene substance; do not end abruptly or obviously too short.",
    };
  }
  return {
    ...range,
    instruction: `Write about ${range.targetWordCount} Chinese characters. Acceptable range: ${range.minWordCount}-${range.maxWordCount}. Do not end clearly below the minimum.`,
  };
}

function buildDraftContinuationBlock(content: string, targetWordCount: number, minWordCount: number): string {
  const trimmed = content.trim();
  const excerpt = trimmed.length > 1400 ? trimmed.slice(-1400) : trimmed;
  return [
    `Current saved draft length: ${countChapterCharacters(trimmed)} Chinese characters.`,
    `Target length: about ${targetWordCount} Chinese characters. Minimum acceptable length: ${minWordCount}.`,
    "Continue from the existing ending. Do not restart the chapter. Do not repeat already written events.",
    "Current draft tail (continue after this):",
    excerpt || "none",
  ].join("\n");
}

/**
 * 续写回声阈值：appended 与草稿尾的 n-gram jaccard 超过该值视为复读草稿尾段。
 */
const CONTINUATION_ECHO_SIMILARITY_THRESHOLD = 0.45;

/**
 * 中文正文常整段一行，行级对齐大概率 overlap=0；追加字符级对齐作为兜底：
 * draftTail 末尾与 appended 开头的最长公共子串（≥12 字符）即视为复读段裁掉。
 */
const MIN_CHAR_OVERLAP = 12;

function longestSuffixPrefixOverlap(draftTail: string, appended: string): number {
  const maxLen = Math.min(draftTail.length, appended.length, 600);
  for (let size = maxLen; size >= MIN_CHAR_OVERLAP; size -= 1) {
    if (draftTail.endsWith(appended.slice(0, size))) {
      return size;
    }
  }
  return 0;
}

/**
 * 裁掉 appended 开头与草稿尾重叠的最长公共段（行级优先，字符级兜底），防止续写复读草稿尾。
 */
export function trimContinuationOverlap(draftTail: string, appended: string): string {
  const appendedLines = appended.split("\n");
  const tailLines = draftTail.split("\n").filter((line) => line.trim().length > 0);
  const maxOverlap = Math.min(appendedLines.length, tailLines.length);
  let overlap = 0;
  for (let size = maxOverlap; size > 0; size -= 1) {
    const tailSlice = tailLines.slice(-size).map((line) => line.trim());
    const headSlice = appendedLines.slice(0, size).map((line) => line.trim());
    if (tailSlice.every((line, index) => line.length > 0 && line === headSlice[index])) {
      overlap = size;
      break;
    }
  }
  if (overlap > 0) {
    return appendedLines.slice(overlap).join("\n").trim();
  }
  // 行级对齐失败（典型：中文整段无换行）→ 字符级最长公共后缀/前缀兜底。
  // 匹配在空白归一化串上做，裁切点通过「逐字符消费原串、跳过空白」映射回原 appended，
  // 避免归一化下标直接切原串导致错位。
  const normalizedTail = draftTail.replace(/\s+/g, "");
  const normalizedAppended = appended.replace(/\s+/g, "");
  const charOverlap = longestSuffixPrefixOverlap(normalizedTail, normalizedAppended);
  if (charOverlap > 0) {
    let consumed = 0;
    let cutIndex = 0;
    while (cutIndex < appended.length && consumed < charOverlap) {
      if (!/\s/.test(appended[cutIndex])) {
        consumed += 1;
      }
      cutIndex += 1;
    }
    return appended.slice(cutIndex).trim();
  }
  return appended.trim();
}

/**
 * 续写回声检测：appended 与草稿尾的 n-gram 相似度。
 */
function continuationEchoSimilarity(draftTail: string, appended: string): number {
  if (!draftTail.trim() || !appended.trim()) {
    return 0;
  }
  return jaccardSimilarity(buildNGramSet(draftTail), buildNGramSet(appended));
}

export class ChapterWritingGraph {
  constructor(private readonly deps: ChapterGraphDeps) {}

  /**
   * 长度欠账留债：合并写 chapter.riskFlags.chapterLengthDebt，
   * 与 continuationUnresolvedHighSimilarity / qualityScorePersistFailed 同款模式。
   * best-effort：失败只告警，不影响定稿主路径。
   */
  private async persistLengthDebtRiskFlag(
    novelId: string,
    chapterId: string,
    chapterOrder: number,
    lengthDebt: {
      targetWordCount: number;
      minWordCount: number;
      finalWordCount: number;
      attempts: number;
    },
  ): Promise<void> {
    try {
      const existing = await prisma.chapter.findFirst({
        where: { id: chapterId, novelId },
        select: { riskFlags: true },
      });
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
      await prisma.chapter.update({
        where: { id: chapterId },
        data: {
          riskFlags: JSON.stringify({
            ...parsed,
            chapterLengthDebt: {
              at: new Date().toISOString(),
              chapterOrder,
              ...lengthDebt,
            },
          }),
        },
      });
    } catch (error) {
      this.deps.logWarn("persist length-debt riskFlag failed", {
        novelId,
        chapterId,
        chapterOrder,
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
  ): Promise<string> {
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

    const continuationGuard = await continuationService.rewriteIfTooSimilar({
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
    return continuationGuard.content;
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
    lengthDebt?: {
      targetWordCount: number;
      minWordCount: number;
      finalWordCount: number;
      attempts: number;
    };
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
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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

      const completion = await runTextPrompt({
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
          novelId: input.novelId,
          chapterId: input.chapter.id,
          stage: "writer_extend",
          triggerReason: "length_recovery",
          signal: input.options.signal,
        },
      });
      let appended = completion.output.trim();
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

      const merged = `${content.trim()}\n\n${appended}`.trim();
      const mergedLength = countChapterCharacters(merged);
      this.deps.logInfo("Chapter draft auto-extended for target length", {
        novelId: input.novelId,
        chapterId: input.chapter.id,
        chapterOrder: input.chapter.order,
        attempt,
        beforeLength: currentLength,
        afterLength: mergedLength,
        targetWordCount: lengthGoal.targetWordCount,
        minWordCount: lengthGoal.minWordCount,
      });
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
      });
      return {
        content,
        lengthDebt: {
          targetWordCount: lengthGoal.targetWordCount,
          minWordCount: lengthGoal.minWordCount,
          finalWordCount: currentLength,
          attempts: maxAttempts,
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
    } | void>;
  }> {
    const continuationPack = (input.contextPackage?.continuation as ContinuationPack | undefined)
      ?? await continuationService.buildChapterContextPack(input.novelId);
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

    const streamed = await streamTextPrompt({
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
        novelId: input.novelId,
        chapterId: input.chapter.id,
        stage: "writer_draft",
        triggerReason: "chapter_initial_draft",
        signal: input.options.signal,
      },
    });

    return {
      stream: streamed.stream as AsyncIterable<BaseMessageChunk>,
      onDone: async (fullContent: string) => {
        // 已取消：禁止 onDone 路径继续定稿/落库（避免 partial final publish）
        throwIfChapterGenerationAborted(input.options.signal);
        const completed = await streamed.complete.catch(() => null);
        const rawContent = completed?.output ?? fullContent;
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
          content: normalized,
          contextPackage,
          options: input.options,
        });
        if (lengthAdjusted.lengthDebt) {
          // 长度欠账：兜底续写仍未达标，logWarn + riskFlags 双写，让用户在债板可见
          this.deps.logWarn("Chapter length debt recorded", {
            novelId: input.novelId,
            chapterId: input.chapter.id,
            chapterOrder: input.chapter.order,
            ...lengthAdjusted.lengthDebt,
          });
          void this.persistLengthDebtRiskFlag(
            input.novelId,
            input.chapter.id,
            input.chapter.order,
            lengthAdjusted.lengthDebt,
          );
        }
        const safeContent = assertChapterContentNotEmpty(lengthAdjusted.content, {
          novelId: input.novelId,
          chapterId: input.chapter.id,
          chapterOrder: input.chapter.order,
          source: "chapter_writer",
        });
        await this.deps.saveDraftAndArtifacts(
          input.novelId,
          input.chapter.id,
          safeContent,
          "drafted",
          {
            scheduleBackgroundSync: !input.options.deferArtifactBackgroundSync,
            syncArtifacts: false,
          },
        );
        return {
          finalContent: safeContent,
          artifactsAlreadySynced: true,
          backgroundSyncDeferred: Boolean(input.options.deferArtifactBackgroundSync),
        };
      },
    };
  }
}
