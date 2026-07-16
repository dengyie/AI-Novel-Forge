/**
 * 书级 SoT 禁词（D2）：从 novel 上可写 JSON 字段读取，默认空。
 * 约定键：`sotBannedTerms`（string[] 或 逗号/换行分隔 string）。
 * 存放位置（按优先级）：
 * 1. storyWorldSliceOverridesJson
 * 2. storyWorldSliceJson（只读 fallback，便于 slice 内嵌）
 *
 * 不新增 DB 列；空表 = 不附加 L0 规则。
 */

export const SOT_BANNED_TERMS_JSON_KEY = "sotBannedTerms" as const;

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const term = String(raw ?? "").trim();
    if (term.length < 2 || seen.has(term)) {
      continue;
    }
    seen.add(term);
    out.push(term);
  }
  return out;
}

function coerceTermList(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return uniqueTerms(value.map((item) => String(item ?? "")));
  }
  if (typeof value === "string") {
    return uniqueTerms(value.split(/[\n；;，,、|/]+/g));
  }
  return [];
}

function readBannedFromRecord(record: Record<string, unknown>): string[] {
  if (SOT_BANNED_TERMS_JSON_KEY in record) {
    return coerceTermList(record[SOT_BANNED_TERMS_JSON_KEY]);
  }
  const nestedQuality = record.writingQuality;
  if (nestedQuality && typeof nestedQuality === "object" && !Array.isArray(nestedQuality)) {
    const quality = nestedQuality as Record<string, unknown>;
    if (SOT_BANNED_TERMS_JSON_KEY in quality) {
      return coerceTermList(quality[SOT_BANNED_TERMS_JSON_KEY]);
    }
  }
  return [];
}

/** 从任意 JSON 文本提取 sotBannedTerms；解析失败 → []。 */
export function extractSotBannedTermsFromJsonBlob(
  raw: string | null | undefined,
): string[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // 允许整段就是词表
      return coerceTermList(parsed);
    }
    if (parsed && typeof parsed === "object") {
      return readBannedFromRecord(parsed as Record<string, unknown>);
    }
  } catch {
    return [];
  }
  return [];
}

export type NovelSotBannedTermsSource = {
  storyWorldSliceOverridesJson?: string | null;
  storyWorldSliceJson?: string | null;
};

/**
 * 书级禁词读取：overrides 优先，再 storyWorldSlice。
 * 两边都有时 **并集**（overrides 是增量/覆盖配置，slice 可带默认 SoT）。
 */
export function extractSotBannedTermsFromNovel(
  novel: NovelSotBannedTermsSource | null | undefined,
): string[] {
  if (!novel) {
    return [];
  }
  const fromOverrides = extractSotBannedTermsFromJsonBlob(novel.storyWorldSliceOverridesJson);
  const fromSlice = extractSotBannedTermsFromJsonBlob(novel.storyWorldSliceJson);
  return uniqueTerms([...fromOverrides, ...fromSlice]);
}

/**
 * 空表可观测：词条数量。不 fail 建书；调用方可用于 readiness / 限流 warn。
 * 空表 = 0 = 不产生 sot_* 码（book-agnostic）。
 */
export function countSotBannedTerms(
  novel: NovelSotBannedTermsSource | null | undefined,
): number {
  return extractSotBannedTermsFromNovel(novel).length;
}
