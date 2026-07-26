import { prisma } from "../../../../db/prisma";
import {
  contentRevisionBumpData,
  createChapterContentConflictError,
  createChapterNotFoundError,
} from "../../chapterContentCas";
import type {
  ChapterContentCommitDatabase,
  CommitChapterContentInput,
  CommittedChapterContent,
} from "./ChapterContentCommitTypes";

function asCommittedChapterContent(row: Record<string, unknown>): CommittedChapterContent {
  if (
    typeof row.novelId !== "string"
    || typeof row.id !== "string"
    || typeof row.content !== "string"
    || typeof row.contentRevision !== "number"
  ) {
    throw new Error("Committed chapter content reload returned an invalid snapshot.");
  }
  return {
    novelId: row.novelId,
    chapterId: row.id,
    content: row.content,
    contentRevision: row.contentRevision,
  };
}

export class ChapterContentCommitService {
  constructor(
    private readonly db: ChapterContentCommitDatabase = prisma as unknown as ChapterContentCommitDatabase,
  ) {}

  async commit(input: CommitChapterContentInput): Promise<CommittedChapterContent> {
    const claimed = await this.db.chapter.updateMany({
      where: {
        id: input.chapterId,
        novelId: input.novelId,
        contentRevision: input.expectedContentRevision,
      },
      data: {
        ...input.statePatch,
        content: input.content,
        ...contentRevisionBumpData(),
      },
    });

    if (claimed.count === 0) {
      const current = await this.db.chapter.findFirst({
        where: { id: input.chapterId, novelId: input.novelId },
        select: { contentRevision: true },
      });
      if (!current) {
        throw createChapterNotFoundError();
      }
      throw createChapterContentConflictError({
        currentContentRevision: Number(current.contentRevision),
        expectedContentRevision: input.expectedContentRevision,
      });
    }

    const committed = await this.db.chapter.findFirst({
      where: { id: input.chapterId, novelId: input.novelId },
      select: {
        novelId: true,
        id: true,
        content: true,
        contentRevision: true,
      },
    });
    if (!committed) {
      throw createChapterNotFoundError();
    }
    return asCommittedChapterContent(committed);
  }
}
