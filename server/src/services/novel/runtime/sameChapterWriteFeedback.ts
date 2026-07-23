/**
 * Same-chapter write-failure feedback for writer retries.
 *
 * Narrow scope (not full QFP bus):
 * - Build short mustFix/evidence lines from empty / Chinese-prose gate errors.
 * - Inject into the *next* same-chapter writer attempt via priorQualityFeedback slots
 *   (reuses existing prior_quality_feedback context block; lines are labeled 本章上枪).
 * - Transport retries stay blind (no *new* prompt injection). If a prior empty/chinese
 *   failure already set lastWriteFeedback, transport re-attempts keep that feedback —
 *   do not clear it on transport (blind retry ≠ wipe correction).
 * - Does not merge into riskFlags.qualityLoop.feedback (avoids prior-chapter lookback pollution).
 */

import {
  isChapterChineseProseGateError,
  type ChapterChineseProseGateError,
} from "./chapterChineseProseGateError";
import {
  isChapterEmptyContentError,
  type ChapterEmptyContentError,
} from "./chapterEmptyContentError";

/** Max prompt lines after packing (header + fixes + evidence + codes). */
export const SAME_CHAPTER_WRITE_FEEDBACK_MAX_LINES = 7;
export const SAME_CHAPTER_WRITE_FEEDBACK_LINE_CHARS = 120;
/** Marker used by context builder to protect the block from summary drops. */
export const SAME_CHAPTER_WRITE_FEEDBACK_MARKER = "【本章上枪】";

export type SameChapterWriteFailureKind = "empty_content" | "chinese_prose_gate";

export interface SameChapterWriteFeedback {
  kind: SameChapterWriteFailureKind;
  codes: string[];
  mustFix: string[];
  evidence: string[];
  /** Prompt-ready lines (already labeled / truncated). */
  lines: string[];
}

function clip(value: string, max = SAME_CHAPTER_WRITE_FEEDBACK_LINE_CHARS): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function uniqueNonEmpty(values: Array<string | null | undefined>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const text = raw?.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

/**
 * Pack lines with evidence priority so metaMarker / reason is not dropped by the line cap.
 * Order: header → evidence → primary mustFix (≤2) → remaining mustFix → codes.
 */
export function packSameChapterWriteFeedbackLines(input: {
  kind: SameChapterWriteFailureKind;
  mustFix: string[];
  evidence: string[];
  codes: string[];
  maxLines?: number;
}): string[] {
  const maxLines = input.maxLines ?? SAME_CHAPTER_WRITE_FEEDBACK_MAX_LINES;
  // Headers must contain SAME_CHAPTER_WRITE_FEEDBACK_MARKER for allowSummary detection.
  const header = input.kind === "chinese_prose_gate"
    ? "【本章上枪·中文硬门失败】下一枪必须改正："
    : "【本章上枪·空正文失败】下一枪必须改正：";

  const evidenceLines = input.evidence.map(
    (item) => `${SAME_CHAPTER_WRITE_FEEDBACK_MARKER}证据：${clip(item)}`,
  );
  const fixLines = input.mustFix.map(
    (item) => `${SAME_CHAPTER_WRITE_FEEDBACK_MARKER}必须：${clip(item)}`,
  );
  const codeLine = input.codes.length > 0
    ? `${SAME_CHAPTER_WRITE_FEEDBACK_MARKER}codes=${input.codes.slice(0, 4).join(",")}`
    : null;

  // Evidence before mustFix so metaMarker/reason is never truncated away by the line cap.
  // Order: header → evidence(≤2) → mustFix(≤2 + extras if room) → codes.
  const packed: Array<string | null | undefined> = [header];
  packed.push(...evidenceLines.slice(0, 2));
  packed.push(...fixLines.slice(0, 2));
  const usedEstimate = 1 + Math.min(2, evidenceLines.length) + Math.min(2, fixLines.length);
  const remainingForExtraFix = maxLines - usedEstimate - (codeLine ? 1 : 0);
  if (remainingForExtraFix > 0 && fixLines.length > 2) {
    packed.push(...fixLines.slice(2, 2 + remainingForExtraFix));
  }
  if (codeLine) {
    packed.push(codeLine);
  }
  return uniqueNonEmpty(packed, maxLines);
}

export function hasSameChapterWriteFeedbackLines(
  lines: Array<string | null | undefined> | null | undefined,
): boolean {
  return (lines ?? []).some(
    (line) => typeof line === "string" && line.includes(SAME_CHAPTER_WRITE_FEEDBACK_MARKER),
  );
}

export function buildSameChapterWriteFeedbackFromEmpty(
  error: ChapterEmptyContentError,
): SameChapterWriteFeedback {
  const codes = uniqueNonEmpty(["empty_content", error.code], 6);
  const mustFix = uniqueNonEmpty([
    "必须输出可保存的中文叙事正文，禁止只返回空白、换行或占位符",
    "禁止只复述任务单/标题而不写场面；从第一字起进入情节",
  ], 5);
  const evidence = uniqueNonEmpty([
    `trimmedLength=${error.details.trimmedLength}, rawLength=${error.details.rawLength}`,
    error.message,
  ], 3);
  const lines = packSameChapterWriteFeedbackLines({
    kind: "empty_content",
    mustFix,
    evidence,
    codes,
  });
  return { kind: "empty_content", codes, mustFix, evidence, lines };
}

export function buildSameChapterWriteFeedbackFromChineseGate(
  error: ChapterChineseProseGateError,
): SameChapterWriteFeedback {
  const reason = error.details.reason?.trim() || "unknown";
  const codes = uniqueNonEmpty([
    "chinese_prose_gate",
    error.code,
    reason,
  ], 6);
  const mustFix = uniqueNonEmpty([
    "全文从第一字起必须是中文叙事正文，禁止英文写作计划/提纲代替正文",
    "禁止 We need / However / Paragraph / Let's write / Writing plan 等 meta 句式",
    "禁止输出大纲条目、段落计划、自我检查清单；直接写小说场面",
  ], 5);
  const evidence = uniqueNonEmpty([
    error.details.metaMarker ? `meta=${error.details.metaMarker}` : null,
    `reason=${reason}; cjk=${error.details.cjkCount}; latin=${error.details.latinCount}`,
    error.message,
  ], 3);
  const lines = packSameChapterWriteFeedbackLines({
    kind: "chinese_prose_gate",
    mustFix,
    evidence,
    codes,
  });
  return { kind: "chinese_prose_gate", codes, mustFix, evidence, lines };
}

/**
 * Map known write-gate errors to same-chapter feedback.
 * Returns null for transport / unknown errors (caller should blind-retry or rethrow).
 */
export function buildSameChapterWriteFeedbackFromError(
  error: unknown,
): SameChapterWriteFeedback | null {
  if (isChapterEmptyContentError(error)) {
    return buildSameChapterWriteFeedbackFromEmpty(error);
  }
  if (isChapterChineseProseGateError(error)) {
    return buildSameChapterWriteFeedbackFromChineseGate(error);
  }
  return null;
}

/** Structured log payload for ops (no QFP write). */
export function formatSameChapterWriteFeedbackLog(input: {
  feedback: SameChapterWriteFeedback | null | undefined;
  willRetry: boolean;
  novelId?: string | null;
  chapterId?: string | null;
  chapterOrder?: number | null;
  attempt?: number | null;
}): Record<string, unknown> {
  const feedback = input.feedback;
  return {
    novelId: input.novelId ?? null,
    chapterId: input.chapterId ?? null,
    chapterOrder: input.chapterOrder ?? null,
    attempt: input.attempt ?? null,
    willRetry: input.willRetry,
    injected: Boolean(feedback && feedback.lines.length > 0 && input.willRetry),
    kind: feedback?.kind ?? null,
    codes: feedback?.codes ?? [],
    lineCount: feedback?.lines.length ?? 0,
    linesPreview: (feedback?.lines ?? []).slice(0, 3),
  };
}

/**
 * Return a shallow-patched assembled chapter so the next writer attempt sees feedback.
 * Mutates neither the original assembled object nor nested writeContext in place.
 *
 * Patches both:
 * - contextPackage.priorQualityFeedback
 * - contextPackage.chapterWriteContext.priorQualityFeedback
 * Writer blocks are built from chapterWriteContext only — both must be updated.
 */
export function applySameChapterWriteFeedbackToAssembled<
  T extends { contextPackage: unknown },
>(
  assembled: T,
  lines: string[] | null | undefined,
): T {
  const feedbackLines = (lines ?? [])
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, SAME_CHAPTER_WRITE_FEEDBACK_MAX_LINES);
  if (feedbackLines.length === 0) {
    return assembled;
  }

  const pkg = (assembled.contextPackage && typeof assembled.contextPackage === "object")
    ? assembled.contextPackage as Record<string, unknown>
    : {};
  const prior = Array.isArray(pkg.priorQualityFeedback)
    ? (pkg.priorQualityFeedback as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const nextPkg: Record<string, unknown> = {
    ...pkg,
    // Same-chapter lines first so the model sees them before prior-chapter debt.
    priorQualityFeedback: [...feedbackLines, ...prior],
  };

  const writeContext = pkg.chapterWriteContext;
  if (writeContext && typeof writeContext === "object" && !Array.isArray(writeContext)) {
    const wc = writeContext as Record<string, unknown>;
    const wcPrior = Array.isArray(wc.priorQualityFeedback)
      ? (wc.priorQualityFeedback as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    nextPkg.chapterWriteContext = {
      ...wc,
      priorQualityFeedback: [...feedbackLines, ...wcPrior],
    };
  }

  return {
    ...assembled,
    contextPackage: nextPkg as T["contextPackage"],
  };
}
