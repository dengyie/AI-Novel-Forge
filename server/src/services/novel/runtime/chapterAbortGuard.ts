/**
 * 章节生成取消守卫：AbortSignal 已触发时禁止继续定稿/落库。
 * 统一 throw 形态，供 writing graph / orchestrator / pipeline 共用。
 */
export function throwIfChapterGenerationAborted(
  signal: AbortSignal | undefined,
  fallbackMessage = "章节生成已取消，跳过正文定稿。",
): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(fallbackMessage);
}
