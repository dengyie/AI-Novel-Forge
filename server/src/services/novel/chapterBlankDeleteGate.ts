import { AppError } from "../../middleware/errorHandler";

export type ChapterBlankDeleteGateInput = {
  content?: string | null;
  chapterStatus?: string | null;
  sceneCards?: string | null;
  taskSheet?: string | null;
  /** true when a queued/running generation job covers this chapter order */
  hasBusyJob?: boolean;
  confirmBlank?: boolean;
};

function sceneCardsNonEmpty(sceneCardsRaw: string | null | undefined): boolean {
  if (typeof sceneCardsRaw !== "string" || !sceneCardsRaw.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(sceneCardsRaw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.length > 0;
    }
    if (parsed && typeof parsed === "object") {
      const scenes = (parsed as { scenes?: unknown }).scenes;
      return Array.isArray(scenes) ? scenes.length > 0 : Object.keys(parsed as object).length > 0;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Blank-chapter delete gate (shared by HTTP core path and legacy ChapterService).
 * Throws AppError with stable codes; callers delete only after this returns.
 */
export function assertChapterBlankDeletable(input: ChapterBlankDeleteGateInput): void {
  const contentEmpty = !String(input.content ?? "").trim();
  const status = input.chapterStatus ?? "unplanned";
  const statusAllowed = status === "unplanned" || status === "pending_generation";
  const taskSheetNonEmpty = Boolean(String(input.taskSheet ?? "").trim())
    && status === "pending_generation";

  if (!contentEmpty) {
    throw new AppError("仅空白章节可删除（本章已有正文）。", 403, { code: "CHAPTER_NOT_BLANK" });
  }
  if (!statusAllowed) {
    throw new AppError(`章节状态为 ${status}，不可删除。`, 403, { code: "CHAPTER_NOT_BLANK" });
  }
  if (input.hasBusyJob) {
    throw new AppError("章节仍有进行中的生成任务，不可删除。", 409, { code: "CHAPTER_BUSY" });
  }
  if (sceneCardsNonEmpty(input.sceneCards)) {
    throw new AppError("章节已有场景规划，不可当作空白章删除。", 403, { code: "CHAPTER_NOT_BLANK" });
  }
  if (taskSheetNonEmpty) {
    throw new AppError("章节已有任务单规划，不可当作空白章删除。", 403, { code: "CHAPTER_NOT_BLANK" });
  }
  if (!input.confirmBlank) {
    throw new AppError("删除空白章节需 confirmBlank=1 确认。", 400, { code: "CHAPTER_CONFIRM_REQUIRED" });
  }
}
