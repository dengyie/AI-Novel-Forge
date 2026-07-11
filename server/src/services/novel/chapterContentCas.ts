import { AppError } from "../../middleware/errorHandler";

/** 章节正文 CAS 冲突错误码（HTTP 409 details.code） */
export const CHAPTER_CONTENT_CONFLICT_CODE = "CHAPTER_CONTENT_CONFLICT" as const;

export interface ChapterContentConflictDetails {
  code: typeof CHAPTER_CONTENT_CONFLICT_CODE;
  currentContentRevision: number;
  expectedContentRevision: number;
}

/**
 * 正文乐观并发冲突。
 * 仅当调用方传入 expectedContentRevision 且与库中 contentRevision 不一致时抛出。
 */
export function createChapterContentConflictError(input: {
  currentContentRevision: number;
  expectedContentRevision: number;
}): AppError {
  const details: ChapterContentConflictDetails = {
    code: CHAPTER_CONTENT_CONFLICT_CODE,
    currentContentRevision: input.currentContentRevision,
    expectedContentRevision: input.expectedContentRevision,
  };
  return new AppError(
    `章节正文已变更（当前 revision=${input.currentContentRevision}，期望 ${input.expectedContentRevision}），请重新加载后再保存。`,
    409,
    details,
  );
}

export function createChapterNotFoundError(): AppError {
  return new AppError("章节不存在", 404);
}

/**
 * Prisma data 片段：content 写入时 revision +1。
 * 使用 increment，避免 read-modify-write 竞态下丢版本。
 */
export function contentRevisionBumpData(): { contentRevision: { increment: number } } {
  return { contentRevision: { increment: 1 } };
}

/**
 * create 时若带非空正文，revision 从 1 起；空正文保持默认 0。
 */
export function initialContentRevisionForCreate(content: string | null | undefined): number {
  return typeof content === "string" && content.length > 0 ? 1 : 0;
}
