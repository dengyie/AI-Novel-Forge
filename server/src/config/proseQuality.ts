/**
 * Prose L0 机械质量配置：垫长/套话词表与阈值。
 * 环境变量可热调；词表用 JSON 数组或「|」分隔字符串覆盖。
 */

function asInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(rawValue ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const value = Math.floor(parsed);
  return Math.max(min, Math.min(max, value));
}

/**
 * 默认垫长/套话词表（网文常见 AI 味过渡）。
 * 注意：不要同时放「空气仿佛」与「空气仿佛凝固」——子串会双计抬 soft 门。
 * 「突然」合法叙事极常见，不进默认表（可用 PROSE_PAD_PHRASES 覆盖加回）。
 */
export const DEFAULT_PAD_PHRASES: readonly string[] = [
  "就在这时",
  "就在此时",
  "与此同时",
  "他深吸一口气",
  "她深吸一口气",
  "不由自主",
  "心中一紧",
  "空气仿佛凝固",
  "时间仿佛静止",
  "目光微微一凝",
  "眉头微微一皱",
];

function parsePadPhraseList(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [...DEFAULT_PAD_PHRASES];
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const terms = parsed
          .map((item) => String(item ?? "").trim())
          .filter((term) => term.length >= 2);
        if (terms.length > 0) {
          return uniquePreserveOrder(terms);
        }
      }
    } catch {
      // fall through to pipe-split
    }
  }
  const terms = trimmed
    .split(/[|｜\n；;，,、]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return terms.length > 0 ? uniquePreserveOrder(terms) : [...DEFAULT_PAD_PHRASES];
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** ≥ 该命中数 → prose_pad_phrase severity=high（blocking）。 */
export const PROSE_PAD_HARD_THRESHOLD = asInt(process.env.PROSE_PAD_HARD_THRESHOLD, 20, 3, 500);

/**
 * readiness soft 门：≥ 该命中数 → needs_patch（即便尚未 high-block）。
 * 默认 8，低于 hard，便于定向 light_repair。
 */
export const PROSE_PAD_SOFT_THRESHOLD = asInt(process.env.PROSE_PAD_SOFT_THRESHOLD, 8, 1, 500);

/** 单 finding 词条最多记录位置数（避免 finding 刷屏）。 */
export const PROSE_PAD_MAX_LOCATIONS_PER_PHRASE = asInt(
  process.env.PROSE_PAD_MAX_LOCATIONS_PER_PHRASE,
  6,
  1,
  40,
);

export const PROSE_PAD_PHRASES: readonly string[] = parsePadPhraseList(process.env.PROSE_PAD_PHRASES);

export interface ProseQualityPadConfig {
  phrases: readonly string[];
  softThreshold: number;
  hardThreshold: number;
  maxLocationsPerPhrase: number;
}

export const proseQualityPadConfig: ProseQualityPadConfig = {
  phrases: PROSE_PAD_PHRASES,
  softThreshold: PROSE_PAD_SOFT_THRESHOLD,
  hardThreshold: PROSE_PAD_HARD_THRESHOLD,
  maxLocationsPerPhrase: PROSE_PAD_MAX_LOCATIONS_PER_PHRASE,
};
