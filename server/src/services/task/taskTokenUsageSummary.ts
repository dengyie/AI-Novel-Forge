import type { TaskTokenUsageSummary } from "@ai-novel/shared/types/task";

export function toTaskTokenUsageSummary(input: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCallCount: number;
  cacheHitTokens?: number | null;
  cacheMissTokens?: number | null;
  cacheReportedCount?: number | null;
  lastTokenRecordedAt?: Date | null;
}): TaskTokenUsageSummary | null {
  const promptTokens = Math.max(0, Math.round(input.promptTokens));
  const completionTokens = Math.max(0, Math.round(input.completionTokens));
  const totalTokens = Math.max(0, Math.round(input.totalTokens));
  const llmCallCount = Math.max(0, Math.round(input.llmCallCount));
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0 && llmCallCount === 0) {
    return null;
  }
  const cacheReportedCount = Math.max(0, Math.round(input.cacheReportedCount ?? 0));
  const cacheHitTokens = input.cacheHitTokens ?? null;
  const cacheMissTokens = input.cacheMissTokens ?? null;
  // 只有厂商上报过缓存的调用才累计；上报数少于调用数 = 覆盖不完整，不得当作完整统计。
  const inputCache = cacheReportedCount > 0 && cacheHitTokens != null && cacheMissTokens != null
    ? {
      cacheHitTokens: Math.max(0, Math.round(cacheHitTokens)),
      cacheMissTokens: Math.max(0, Math.round(cacheMissTokens)),
      complete: cacheReportedCount >= llmCallCount,
    }
    : null;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    llmCallCount,
    ...(inputCache ? { inputCache } : {}),
    lastRecordedAt: input.lastTokenRecordedAt?.toISOString() ?? null,
  };
}
