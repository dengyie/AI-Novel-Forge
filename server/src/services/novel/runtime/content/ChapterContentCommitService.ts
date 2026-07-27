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

    // updateMany count=1 已证明 N -> N+1 与正文写入原子成功。此处不能再按 id 无约束重读：
    // 另一位写者可能在 CAS 成功后立刻推进到 N+2，重读会把对方正文冒充成本次提交快照，
    // 让后续质量、事实和时间线投影消费错误事实源。返回本次 CAS 可确定的快照即可。
    return {
      novelId: input.novelId,
      chapterId: input.chapterId,
      content: input.content,
      contentRevision: input.expectedContentRevision + 1,
    };
  }
}
