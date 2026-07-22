import type { ChineseProseGateResult } from "../../../utils/chineseProseGate";

export interface ChapterChineseProseGateErrorDetails {
  novelId?: string | null;
  chapterId?: string | null;
  chapterOrder?: number | null;
  source: string;
  reason?: string;
  metaMarker?: string;
  cjkCount: number;
  latinCount: number;
  rawLength: number;
}

/**
 * Writer draft failed the Chinese prose hard gate (English meta / english-heavy).
 * Pipeline/stream may retry once (same budget shape as empty-content).
 */
export class ChapterChineseProseGateError extends Error {
  readonly code = "CHAPTER_CHINESE_PROSE_GATE";
  readonly details: ChapterChineseProseGateErrorDetails;

  constructor(
    details: ChapterChineseProseGateErrorDetails,
    message = "章节正文未通过中文硬门，禁止落库英文 meta / 英文主导草稿。",
  ) {
    super(message);
    this.name = "ChapterChineseProseGateError";
    this.details = details;
    Object.setPrototypeOf(this, ChapterChineseProseGateError.prototype);
  }
}

export function isChapterChineseProseGateError(error: unknown): error is ChapterChineseProseGateError {
  return error instanceof ChapterChineseProseGateError
    || (
      Boolean(error)
      && typeof error === "object"
      && (error as { code?: unknown }).code === "CHAPTER_CHINESE_PROSE_GATE"
    );
}

export function buildChapterChineseProseGateError(
  content: string,
  gate: ChineseProseGateResult,
  details: Omit<ChapterChineseProseGateErrorDetails, "rawLength" | "cjkCount" | "latinCount" | "reason" | "metaMarker"> & {
    reason?: string;
    metaMarker?: string;
  },
): ChapterChineseProseGateError {
  const reason = gate.reason ?? details.reason ?? "unknown";
  const meta = gate.metaMarker ?? details.metaMarker;
  const message = `章节正文未通过中文硬门（${reason}）`
    + (meta ? `：${meta}` : "")
    + "。请重试生成，禁止落库英文 meta / 英文主导草稿。";
  return new ChapterChineseProseGateError({
    novelId: details.novelId,
    chapterId: details.chapterId,
    chapterOrder: details.chapterOrder,
    source: details.source,
    reason,
    metaMarker: meta,
    cjkCount: gate.cjkCount,
    latinCount: gate.latinCount,
    rawLength: (content ?? "").length,
  }, message);
}
