/**
 * Provider-reported input accounting（移植自上游 2026-10-05 llm-cache-observability 设计）。
 * 命中与未命中均包含于输入总量；缓存创建（write）属于未命中，不在合计之外再次相加。
 * 明确返回 0 是有效事实；字段缺失是未知（null），不能当作 0。
 */
export interface LlmInputCacheUsage {
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  cacheWriteTokens: number | null;
  cacheUsageStatus: "reported" | "unavailable" | "invalid";
}
