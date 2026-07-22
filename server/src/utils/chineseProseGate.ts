/**
 * Shared CJK-vs-latin prose heuristic for novel chapter drafts.
 * Aligns with world-layer `needsChineseTextTranslation` (latin≥12 & weak CJK).
 */

const META_ENGLISH_MARKERS = [
  /\bWe need\b/i,
  /\bMust produce\b/i,
  /\bMust include\b/i,
  /\bParagraph\b/i,
  /\bHowever\b/,
  /\bLet's\b/i,
  /\bThus we\b/i,
  /\bNeed to\b/i,
  /\bWriting plan\b/i,
  /\bScene \d+\b/i,
];

export interface ChineseProseGateResult {
  ok: boolean;
  reason?: string;
  cjkCount: number;
  latinCount: number;
  metaMarker?: string;
}

export function assessChineseProse(text: string): ChineseProseGateResult {
  const normalized = (text || "").trim();
  if (!normalized) {
    return { ok: false, reason: "empty", cjkCount: 0, latinCount: 0 };
  }

  const cjkCount = (normalized.match(/[一-鿿]/g) ?? []).length;
  const latinCount = (normalized.match(/[A-Za-z]/g) ?? []).length;

  for (const pattern of META_ENGLISH_MARKERS) {
    const match = pattern.exec(normalized);
    if (match) {
      return {
        ok: false,
        reason: "english_meta_marker",
        cjkCount,
        latinCount,
        metaMarker: match[0],
      };
    }
  }

  // Short pure-CJK is fine; english-heavy drafts fail.
  if (latinCount >= 40 && (cjkCount === 0 || cjkCount * 2 < latinCount)) {
    return {
      ok: false,
      reason: "english_heavy",
      cjkCount,
      latinCount,
    };
  }

  // Absolute floor for a "chapter": need some CJK once length is non-trivial.
  const compactLen = normalized.replace(/\s+/g, "").length;
  if (compactLen >= 800 && cjkCount < 200) {
    return {
      ok: false,
      reason: "insufficient_cjk",
      cjkCount,
      latinCount,
    };
  }

  return { ok: true, cjkCount, latinCount };
}

export function isEnglishHeavyProse(text: string): boolean {
  return !assessChineseProse(text).ok;
}
