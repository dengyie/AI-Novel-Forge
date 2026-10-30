import { unknownCache, type LlmTokenUsageSnapshot } from "./types";

/** 厂商流式快照是累计值，不是增量计费：合并取最新累计，不求和。 */
export function mergeStreamTokenUsage(
  current: LlmTokenUsageSnapshot | null,
  next: LlmTokenUsageSnapshot | null,
): LlmTokenUsageSnapshot | null {
  if (!current) return next;
  if (!next) return current;
  const promptTokens = Math.max(current.promptTokens, next.promptTokens);
  const completionTokens = Math.max(current.completionTokens, next.completionTokens);
  // 输入总量一致时保留同次调用早先返回的合法缓存明细；输入变化或来源冲突标记 invalid。
  let inputCache = next.inputCache?.cacheUsageStatus === "reported"
    ? next.inputCache
    : current.inputCache ?? next.inputCache;
  const changed = current.promptTokens > 0 && next.promptTokens > 0 && current.promptTokens !== next.promptTokens;
  if (
    changed
    || current.inputCache?.cacheUsageStatus === "invalid"
    || next.inputCache?.cacheUsageStatus === "invalid"
    || (inputCache?.cacheUsageStatus === "reported"
      && inputCache.cacheHitTokens! + inputCache.cacheMissTokens! !== promptTokens)
    || (current.inputCache?.cacheUsageStatus === "reported"
      && next.inputCache?.cacheUsageStatus === "reported"
      && current.inputCache.cacheHitTokens !== next.inputCache.cacheHitTokens)
  ) {
    inputCache = unknownCache("invalid");
  }
  return {
    promptTokens,
    completionTokens,
    ...((current.reasoningTokens !== undefined || next.reasoningTokens !== undefined)
      ? { reasoningTokens: Math.max(current.reasoningTokens ?? 0, next.reasoningTokens ?? 0) }
      : {}),
    totalTokens: Math.max(current.totalTokens, next.totalTokens, promptTokens + completionTokens),
    ...(inputCache ? { inputCache } : {}),
  };
}
