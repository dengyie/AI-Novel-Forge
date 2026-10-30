import type { LlmInputCacheUsage } from "@ai-novel/shared/types/llmUsage";
import { summarizeUsage } from "./summarizeUsage";
import { tokenCount, unknownCache, type LlmTokenUsageSnapshot, type UsageDecodeOptions } from "./types";

type Obj = Record<string, any>;
function object(value: unknown): Obj {
  return value && typeof value === "object" ? value as Obj : {};
}
function first(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function base(u: Obj, nativeAnthropic: boolean): LlmTokenUsageSnapshot | null {
  let promptTokens = tokenCount(first(u.prompt_tokens, u.promptTokens, u.input_tokens, u.inputTokens, u.promptTokenCount)) ?? 0;
  if (nativeAnthropic) {
    // 原生 Anthropic input 不含 read/creation；SDK 标准 input 已归一化，不能重复相加。
    promptTokens += (tokenCount(u.cache_read_input_tokens) ?? 0) + (tokenCount(u.cache_creation_input_tokens) ?? 0);
  }
  const completionTokens = tokenCount(first(u.completion_tokens, u.completionTokens, u.output_tokens, u.outputTokens, u.candidatesTokenCount)) ?? 0;
  const reasoningTokens = tokenCount(first(
    u.completion_tokens_details?.reasoning_tokens,
    u.output_token_details?.reasoning,
    u.outputTokenDetails?.reasoning,
    u.thoughtsTokenCount,
  ));
  const totalTokens = Math.max(tokenCount(first(u.total_tokens, u.totalTokens, u.totalTokenCount)) ?? 0, promptTokens + completionTokens);
  if (!totalTokens) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
  };
}

function cache(u: Obj, total: number): LlmInputCacheUsage {
  // 已归一化的 inputCache（例如 SDK/流式路径先行解码）直接校验收编。
  if (u.inputCache) {
    const value = object(u.inputCache);
    if (value.cacheUsageStatus !== "reported") {
      return unknownCache(value.cacheUsageStatus === "invalid" ? "invalid" : "unavailable");
    }
    if (
      tokenCount(value.cacheHitTokens) === null
      || tokenCount(value.cacheMissTokens) === null
      || value.cacheHitTokens + value.cacheMissTokens !== total
      || (value.cacheWriteTokens != null
        && (tokenCount(value.cacheWriteTokens) === null || value.cacheWriteTokens > value.cacheMissTokens))
    ) {
      return unknownCache("invalid");
    }
    return {
      cacheHitTokens: value.cacheHitTokens,
      cacheMissTokens: value.cacheMissTokens,
      cacheWriteTokens: value.cacheWriteTokens ?? null,
      cacheUsageStatus: "reported",
    };
  }
  // 只有厂商实际提供的字段才构成一次缓存观测；缺字段是未知，不是 0。
  const reads = [
    u.prompt_cache_hit_tokens,
    u.prompt_tokens_details?.cached_tokens,
    u.input_tokens_details?.cached_tokens,
    u.input_token_details?.cache_read,
    u.cached_tokens,
    u.cachedContentTokenCount,
    u.cache_read_input_tokens,
  ].filter((v) => v !== undefined && v !== null);
  const writes = [
    u.cache_creation_input_tokens,
    u.input_token_details?.cache_creation,
    u.input_tokens_details?.cache_write_tokens,
    u.prompt_tokens_details?.cache_creation_input_tokens,
  ].filter((v) => v !== undefined && v !== null);
  const missRaw = u.prompt_cache_miss_tokens;
  if (!reads.length) return unknownCache();
  if (
    [...reads, ...writes, ...(missRaw !== undefined && missRaw !== null ? [missRaw] : [])]
      .some((v) => tokenCount(v) === null)
  ) {
    return unknownCache("invalid");
  }
  const read = reads[0] as number;
  const write = writes.length ? writes[0] as number : null;
  if (
    reads.some((v) => v !== read)
    || writes.some((v) => v !== write)
    || read > total
    || (missRaw != null && read + missRaw !== total)
    || (write !== null && write > total - read)
  ) {
    return unknownCache("invalid");
  }
  return {
    cacheHitTokens: read,
    cacheMissTokens: total - read,
    cacheWriteTokens: write,
    cacheUsageStatus: "reported",
  };
}

export function extractLlmTokenUsage(output: unknown, options: UsageDecodeOptions = {}): LlmTokenUsageSnapshot | null {
  if (Array.isArray(output)) {
    // 不同物理调用才求和；任一调用缺缓存报告时汇总不得伪造完整覆盖。
    return summarizeUsage(output.map((item) => extractLlmTokenUsage(item, options)));
  }
  const c = object(output);
  const sources = [
    { u: object(c.usage_metadata), sdk: true },
    { u: object(c.usageMetadata), sdk: options.protocol !== "gemini-native" },
    { u: object(c.response_metadata?.usage), sdk: false },
    { u: object(c.response_metadata?.tokenUsage), sdk: true },
    { u: object(c.responseMetadata?.usage), sdk: false },
    { u: object(c.responseMetadata?.tokenUsage), sdk: true },
    { u: object(c.llmOutput?.tokenUsage), sdk: true },
    { u: object(c.llmOutput?.estimatedTokenUsage), sdk: true },
  ];
  const isNativeAnthropic = (u: Obj) => options.protocol === "anthropic"
    || "cache_read_input_tokens" in u
    || "cache_creation_input_tokens" in u;
  const candidates = sources.map(({ u, sdk }) => ({
    u,
    usage: base(u, !sdk && isNativeAnthropic(u)),
  }));
  const usage = candidates.find((entry) => entry.usage)?.usage;
  if (!usage) return null;
  const caches = candidates
    .map((entry) => cache(entry.u, usage.promptTokens))
    .filter((entry) => entry.cacheUsageStatus !== "unavailable");
  const reported = caches.filter((entry) => entry.cacheUsageStatus === "reported");
  const mismatch = reported.some((entry) => entry.cacheHitTokens !== reported[0]?.cacheHitTokens
    || entry.cacheMissTokens !== reported[0]?.cacheMissTokens);
  const writes = reported.map((entry) => entry.cacheWriteTokens).filter((v) => v !== null);
  usage.inputCache = caches.some((entry) => entry.cacheUsageStatus === "invalid") || mismatch || writes.some((v) => v !== writes[0])
    ? unknownCache("invalid")
    : reported.length
      ? { ...reported[0], cacheWriteTokens: writes[0] ?? null }
      : unknownCache();
  return usage;
}
