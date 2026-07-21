// 单条章节摘要注入 prompt 前的字符上限：此前只做数量截断（前3章），
// 单条 LLM/regex 摘要可能上千字符，直接整段进 writer prompt 会稀释预算。
export const MAX_PREVIOUS_CHAPTER_SUMMARY_CHARS = 240;

export function clipPreviousChapterSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PREVIOUS_CHAPTER_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_PREVIOUS_CHAPTER_SUMMARY_CHARS).trimEnd()}…`;
}

export function buildPreviousChaptersSummary(
  requestSummary: string[] | undefined,
  summaries: Array<{ chapter: { order: number; title: string }; summary: string }>,
): string[] {
  if (requestSummary?.length) {
    return requestSummary.map(clipPreviousChapterSummary).filter(Boolean);
  }
  return summaries
    .map((item) => clipPreviousChapterSummary(`第${item.chapter.order}章《${item.chapter.title}》 ${item.summary}`))
    .filter(Boolean);
}

export function parseJsonStringArraySafe(value: string | null | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}
