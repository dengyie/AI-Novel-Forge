import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatOpenAI } from "@langchain/openai";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import {
  extractLlmTokenUsage,
  mergeStreamTokenUsage,
  type LlmTokenUsageSnapshot,
} from "../platform/llm/usage";

export { extractLlmTokenUsage, mergeStreamTokenUsage } from "../platform/llm/usage";
export type { LlmTokenUsageSnapshot } from "../platform/llm/usage";

export interface LlmUsageTrackingContext {
  workflowTaskId?: string | null;
  generationJobId?: string | null;
  styleExtractionTaskId?: string | null;
  audiobookTaskId?: string | null;
  directorTelemetry?: boolean | null;
  novelId?: string | null;
  directorRunId?: string | null;
  directorStepIdempotencyKey?: string | null;
  directorNodeKey?: string | null;
}

export interface LlmUsageTrackingMeta {
  requestProtocol?: string | null;
  provider?: LLMProvider | string | null;
  model?: string | null;
  taskType?: string | null;
  modelRoute?: string | null;
  routeDegraded?: boolean | null;
  promptMeta?: {
    promptId?: string | null;
    promptVersion?: string | null;
    novelId?: string | null;
    taskId?: string | null;
    chapterId?: string | null;
    volumeId?: string | null;
    stage?: string | null;
    itemKey?: string | null;
    scope?: string | null;
    entrypoint?: string | null;
  } | null;
}

interface TrackedUsageRecordInput {
  durationMs?: number | null;
  status?: string;
  meta?: LlmUsageTrackingMeta;
  metadata?: Record<string, unknown>;
}

const usageTrackingStore = new AsyncLocalStorage<LlmUsageTrackingContext>();
const LLM_USAGE_PATCHED = Symbol("LLM_USAGE_PATCHED");

type PatchableChatOpenAI = ChatOpenAI & {
  [LLM_USAGE_PATCHED]?: boolean;
};

function decodeProtocol(meta: LlmUsageTrackingMeta | undefined): "anthropic" | "openai-compatible" {
  return meta?.requestProtocol === "anthropic" ? "anthropic" : "openai-compatible";
}

function mergeContextValue<T extends string | null | undefined>(current: T, next: T): string | null {
  if (next !== undefined) {
    return typeof next === "string" && next.trim().length > 0 ? next.trim() : null;
  }
  return typeof current === "string" && current.trim().length > 0 ? current.trim() : null;
}

function mergeBooleanValue(current: boolean | null | undefined, next: boolean | null | undefined): boolean | null {
  if (next !== undefined) {
    return next === true;
  }
  return current === true;
}

export function runWithLlmUsageTracking<T>(
  context: LlmUsageTrackingContext,
  runner: () => Promise<T>,
): Promise<T> {
  const current = usageTrackingStore.getStore();
  return usageTrackingStore.run(
    {
      workflowTaskId: mergeContextValue(current?.workflowTaskId, context.workflowTaskId),
      generationJobId: mergeContextValue(current?.generationJobId, context.generationJobId),
      styleExtractionTaskId: mergeContextValue(current?.styleExtractionTaskId, context.styleExtractionTaskId),
      audiobookTaskId: mergeContextValue(current?.audiobookTaskId, context.audiobookTaskId),
      directorTelemetry: mergeBooleanValue(current?.directorTelemetry, context.directorTelemetry),
      novelId: mergeContextValue(current?.novelId, context.novelId),
      directorRunId: mergeContextValue(current?.directorRunId, context.directorRunId),
      directorStepIdempotencyKey: mergeContextValue(
        current?.directorStepIdempotencyKey,
        context.directorStepIdempotencyKey,
      ),
      directorNodeKey: mergeContextValue(current?.directorNodeKey, context.directorNodeKey),
    },
    runner,
  );
}

function resolveAttributionStatus(context: LlmUsageTrackingContext): "step_attributed" | "task_only" | "unattributed" {
  if (context.directorStepIdempotencyKey?.trim()) {
    return "step_attributed";
  }
  if (context.workflowTaskId?.trim() || context.directorRunId?.trim() || context.directorNodeKey?.trim()) {
    return "task_only";
  }
  return "unattributed";
}

function buildPromptNodeKey(meta: LlmUsageTrackingMeta | undefined): string | null {
  const stage = meta?.promptMeta?.stage?.trim();
  const itemKey = meta?.promptMeta?.itemKey?.trim();
  if (stage && itemKey) {
    return `${stage}.${itemKey}`;
  }
  return stage || null;
}

function buildDirectorUsageMetadata(input: TrackedUsageRecordInput | undefined): string | null {
  const promptMeta = input?.meta?.promptMeta;
  const metadata = {
    ...(input?.metadata ?? {}),
    taskType: input?.meta?.taskType ?? null,
    modelRoute: input?.meta?.modelRoute ?? input?.meta?.taskType ?? null,
    routeDegraded: input?.meta?.routeDegraded === true,
    chapterId: promptMeta?.chapterId ?? null,
    volumeId: promptMeta?.volumeId ?? null,
    stage: promptMeta?.stage ?? null,
    itemKey: promptMeta?.itemKey ?? null,
    scope: promptMeta?.scope ?? null,
    entrypoint: promptMeta?.entrypoint ?? null,
  };
  const meaningful = Object.values(metadata).some((value) => value !== null && value !== undefined && value !== "");
  return meaningful ? JSON.stringify(metadata) : null;
}

async function recordDirectorLlmUsage(input: {
  context: LlmUsageTrackingContext;
  usage: LlmTokenUsageSnapshot;
  record?: TrackedUsageRecordInput;
  recordedAt: Date;
}): Promise<void> {
  if (input.context.directorTelemetry !== true) {
    return;
  }
  const promptMeta = input.record?.meta?.promptMeta;
  const cache = input.usage.inputCache;
  await prisma.directorLlmUsageRecord.create({
    data: {
      novelId: input.context.novelId ?? promptMeta?.novelId ?? null,
      taskId: input.context.workflowTaskId ?? promptMeta?.taskId ?? null,
      runId: input.context.directorRunId ?? null,
      stepIdempotencyKey: input.context.directorStepIdempotencyKey ?? null,
      nodeKey: input.context.directorNodeKey ?? buildPromptNodeKey(input.record?.meta) ?? null,
      promptAssetKey: promptMeta?.promptId ?? null,
      promptVersion: promptMeta?.promptVersion ?? null,
      modelRoute: input.record?.meta?.modelRoute ?? input.record?.meta?.taskType ?? null,
      provider: input.record?.meta?.provider ? String(input.record.meta.provider) : null,
      model: input.record?.meta?.model ?? null,
      status: input.record?.status ?? "recorded",
      attributionStatus: resolveAttributionStatus(input.context),
      durationMs: typeof input.record?.durationMs === "number"
        ? Math.max(0, Math.round(input.record.durationMs))
        : null,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      totalTokens: input.usage.totalTokens,
      ...(cache?.cacheUsageStatus === "reported"
        ? {
          cacheHitTokens: cache.cacheHitTokens,
          cacheMissTokens: cache.cacheMissTokens,
          cacheWriteTokens: cache.cacheWriteTokens,
        }
        : {}),
      metadataJson: buildDirectorUsageMetadata(input.record),
      recordedAt: input.recordedAt,
    },
  }).catch(() => undefined);
}

type CacheIncrementTarget = "GenerationJob" | "NovelWorkflowTask" | "StyleExtractionTask" | "AudiobookTask";

// 缓存列在既有行上默认是 NULL（缺报告必须保持 NULL = 未知），直接用 Prisma 的 increment 会
// 让 SQL 里的 NULL + n 变成 NULL（自增空转，永远停在 NULL）。改用 COALESCE 做 NULL 安全的累加，
// SQLite 与 PostgreSQL 都支持，且不依赖「建行时先写默认值」的额外迁移。
function incrementTaskCacheColumns(cache: NonNullable<LlmTokenUsageSnapshot["inputCache"]>) {
  const sets: Prisma.Sql[] = [
    Prisma.sql`"cacheHitTokens" = COALESCE("cacheHitTokens", 0) + ${cache.cacheHitTokens ?? 0}`,
    Prisma.sql`"cacheMissTokens" = COALESCE("cacheMissTokens", 0) + ${cache.cacheMissTokens ?? 0}`,
  ];
  if (cache.cacheWriteTokens != null) {
    sets.push(Prisma.sql`"cacheWriteTokens" = COALESCE("cacheWriteTokens", 0) + ${cache.cacheWriteTokens}`);
  }
  sets.push(Prisma.sql`"cacheReportedCount" = COALESCE("cacheReportedCount", 0) + 1`);
  return async (tableName: CacheIncrementTarget, id: string): Promise<void> => {
    const table = Prisma.raw(`"${tableName}"`);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE ${table}
      SET ${Prisma.join(sets, ", ")}
      WHERE "id" = ${id}
    `).catch(() => undefined);
  };
}

export async function recordTrackedLlmUsage(
  usage: LlmTokenUsageSnapshot | null,
  record?: TrackedUsageRecordInput,
): Promise<void> {
  if (!usage) {
    return;
  }
  const context = usageTrackingStore.getStore();
  if (!context) {
    return;
  }
  const hasAttributionTarget = context.workflowTaskId
    || context.generationJobId
    || context.styleExtractionTaskId
    || context.audiobookTaskId;
  if (!hasAttributionTarget && context.directorTelemetry !== true) {
    return;
  }
  const now = new Date();
  // 缓存命中包含于真实输入，不参与预算口径；只有厂商明确上报的调用才累计缓存列。
  const reportCache = usage.inputCache?.cacheUsageStatus === "reported";
  const tokenIncrement = {
    promptTokens: { increment: usage.promptTokens },
    completionTokens: { increment: usage.completionTokens },
    totalTokens: { increment: usage.totalTokens },
    llmCallCount: { increment: 1 },
  };
  const cacheIncrement = reportCache
    ? incrementTaskCacheColumns(usage.inputCache!)
    : () => Promise.resolve(null);
  await Promise.all([
    context?.directorTelemetry === true
      ? recordDirectorLlmUsage({
        context,
        usage,
        record,
        recordedAt: now,
      })
      : Promise.resolve(null),
    context.workflowTaskId
      ? prisma.novelWorkflowTask.updateMany({
        where: { id: context.workflowTaskId },
        data: { ...tokenIncrement, lastTokenRecordedAt: now },
      }).catch(() => null)
        .then(() => cacheIncrement("NovelWorkflowTask", context.workflowTaskId!))
      : Promise.resolve(null),
    context.generationJobId
      ? prisma.generationJob.updateMany({
        where: { id: context.generationJobId },
        data: { ...tokenIncrement, lastTokenRecordedAt: now },
      }).catch(() => null)
        .then(() => cacheIncrement("GenerationJob", context.generationJobId!))
      : Promise.resolve(null),
    context.styleExtractionTaskId
      ? prisma.styleExtractionTask.updateMany({
        where: { id: context.styleExtractionTaskId },
        data: { ...tokenIncrement, lastTokenRecordedAt: now },
      }).catch(() => null)
        .then(() => cacheIncrement("StyleExtractionTask", context.styleExtractionTaskId!))
      : Promise.resolve(null),
    context.audiobookTaskId
      ? prisma.audiobookTask.updateMany({
        where: { id: context.audiobookTaskId },
        data: { ...tokenIncrement, lastTokenRecordedAt: now },
      }).catch(() => null)
        .then(() => cacheIncrement("AudiobookTask", context.audiobookTaskId!))
      : Promise.resolve(null),
  ]);
}

function wrapUsageTrackedStream<T>(
  rawStream: AsyncIterable<T>,
  startedAt: number,
  meta?: LlmUsageTrackingMeta,
): AsyncIterable<T> {
  const protocol = decodeProtocol(meta);
  return {
    async *[Symbol.asyncIterator]() {
      let usage: LlmTokenUsageSnapshot | null = null;
      try {
        for await (const chunk of rawStream) {
          usage = mergeStreamTokenUsage(usage, extractLlmTokenUsage(chunk, { protocol }));
          yield chunk;
        }
      } finally {
        await recordTrackedLlmUsage(usage, {
          durationMs: Date.now() - startedAt,
          meta,
        });
      }
    },
  };
}

// 通过 invoke 观察过的 SDK 批量子结果不再重复登记（对象身份判定）。
const observedResults = new WeakSet<object>();

export function attachLLMUsageTracking(llm: ChatOpenAI, meta?: LlmUsageTrackingMeta): ChatOpenAI {
  const patchable = llm as PatchableChatOpenAI;
  if (patchable[LLM_USAGE_PATCHED]) {
    return llm;
  }
  const protocol = decodeProtocol(meta);
  const originalInvoke = llm.invoke.bind(llm);
  const originalStream = llm.stream.bind(llm);
  const originalBatch = llm.batch.bind(llm);

  patchable.invoke = (async (...args: Parameters<ChatOpenAI["invoke"]>) => {
    const startedAt = Date.now();
    const result = await originalInvoke(...args);
    if (result && typeof result === "object") {
      observedResults.add(result);
    }
    await recordTrackedLlmUsage(extractLlmTokenUsage(result, { protocol }), {
      durationMs: Date.now() - startedAt,
      meta,
    });
    return result;
  }) as ChatOpenAI["invoke"];

  patchable.stream = (async (...args: Parameters<ChatOpenAI["stream"]>) => {
    const startedAt = Date.now();
    const result = await originalStream(...args);
    return wrapUsageTrackedStream(
      result as AsyncIterable<unknown>,
      startedAt,
      meta,
    ) as Awaited<ReturnType<ChatOpenAI["stream"]>>;
  }) as ChatOpenAI["stream"];

  patchable.batch = (async (...args: Parameters<ChatOpenAI["batch"]>) => {
    const startedAt = Date.now();
    const result = await originalBatch(...args);
    // SDK 直接返回的多个结果逐项登记；内部已观察过的子结果不重复计数。
    const observed = result.filter((item) => item && typeof item === "object" && observedResults.has(item)).length;
    if (observed === 0) {
      await recordTrackedLlmUsage(extractLlmTokenUsage(result, { protocol }), {
        durationMs: Date.now() - startedAt,
        meta,
      });
    } else if (observed < result.length) {
      const unobserved = result.filter((item) => !(item && typeof item === "object" && observedResults.has(item)));
      await recordTrackedLlmUsage(extractLlmTokenUsage(unobserved, { protocol }), {
        durationMs: Date.now() - startedAt,
        meta,
      });
    }
    return result;
  }) as ChatOpenAI["batch"];

  Object.defineProperty(patchable, LLM_USAGE_PATCHED, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  return llm;
}
